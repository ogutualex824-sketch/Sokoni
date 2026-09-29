'use strict';
/**
 * SOKONI — BUSINESS CAPABILITIES: the canonical capability authority, READ MODEL
 * functions/shared/business-capabilities.js                                (C2)
 *
 * ONE business identity → approved capabilities → capability state stamped at
 * approval. This module defines the vocabulary, the stamp's schema, the
 * observation of what production records currently contain, the proposed
 * capability those observations support, and the routing contract that
 * storefront / card / dashboard resolvers will consume.
 *
 * WHAT IT IS NOT (yet). It stamps nothing, writes nothing, and is imported by
 * no production path. It exists so that the stamping slice, the migration
 * slices and the resolver slice all speak one vocabulary before any of them
 * changes a record. `scripts/test-business-capabilities.js` asserts the
 * "no production importer" fact so that adoption is a deliberate act.
 *
 * ── THE THREE LEGITIMATE STATES ────────────────────────────────────────────
 *   PRODUCTS · SERVICES · PRODUCTS_AND_SERVICES
 * plus two read-model states that are NEVER routable:
 *   UNCLASSIFIED   nothing approved, or nothing observed
 *   CONFLICT       the records disagree with each other or with a stamp
 *
 * ── CAPABILITY IS AN APPROVED FACT, ADDITIVE, INDEPENDENTLY APPROVABLE ─────
 * A business is never TRANSFORMED from PRODUCTS into SERVICES because someone
 * chose a service label. PRODUCTS approved + SERVICES approved = both. Nothing
 * here derives capability from a label, a URL, the collection a card came
 * from, a localStorage role, or the dashboard a user happened to enter.
 * Registry documents (`sellers`, `providers`) are OBSERVED — through the
 * liveness rule business-scope.js already owns — and reported as observations;
 * they propose a capability, they do not stamp one.
 *
 * ── WHERE THE STAMP WILL LIVE ──────────────────────────────────────────────
 *   businesses/{businessId}.capabilities = {
 *     version: 1,
 *     PRODUCTS: { state, decidedBy, decidedAt, applicationId, source },
 *     SERVICES: { state, decidedBy, decidedAt, applicationId, source },
 *   }
 *   state  ∈ approved | pending | suspended | revoked | absent  (missing key = absent)
 *   source ∈ application_approval | admin
 * Written only by a server approval path (a future slice), never by a client;
 * the rules slice will add `capabilities` to the protected field set. A stamp
 * that does not validate is INVALID_STAMP and the business is CONFLICT — a
 * malformed authority is not an authority.
 *
 * ── PURE ───────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network. Callers load the documents and pass them.
 */
const scope = require('./business-scope');

const CAPABILITY = Object.freeze({ PRODUCTS: 'PRODUCTS', SERVICES: 'SERVICES' });
const CAPABILITIES = Object.freeze([CAPABILITY.PRODUCTS, CAPABILITY.SERVICES]);
const CAPABILITY_STATE = Object.freeze(['approved', 'pending', 'suspended', 'revoked', 'absent']);
const STAMP_SOURCE = Object.freeze(['application_approval', 'admin']);
const STAMP_VERSION = 1;

const CLASSIFICATION = Object.freeze({
  PRODUCTS: 'PRODUCTS',
  SERVICES: 'SERVICES',
  PRODUCTS_AND_SERVICES: 'PRODUCTS_AND_SERVICES',
  UNCLASSIFIED: 'UNCLASSIFIED',
  CONFLICT: 'CONFLICT',
});
const ROUTABLE = Object.freeze([CLASSIFICATION.PRODUCTS, CLASSIFICATION.SERVICES, CLASSIFICATION.PRODUCTS_AND_SERVICES]);

const AUTHORITY = Object.freeze({
  STAMPED: 'STAMPED',                 /* a valid stamp exists; it is the authority */
  NOT_YET_STAMPED: 'NOT_YET_STAMPED', /* no stamp; the proposal is what observation supports */
  INVALID_STAMP: 'INVALID_STAMP',     /* a stamp exists and does not validate */
});

/* Application roles → the capability they request. `health` and `legal` are service
   professions in the application vocabulary; a driver requests neither. */
const ROLE_TO_CAPABILITY = Object.freeze({
  seller: CAPABILITY.PRODUCTS, merchant: CAPABILITY.PRODUCTS, vendor: CAPABILITY.PRODUCTS,
  provider: CAPABILITY.SERVICES, professional: CAPABILITY.SERVICES, health: CAPABILITY.SERVICES, legal: CAPABILITY.SERVICES,
});

/* ── The stamp ────────────────────────────────────────────────────────────── */
function validateStamp(cap) {
  const errors = [];
  if (cap === undefined || cap === null) return { ok: false, errors: ['absent'], present: false };
  if (typeof cap !== 'object' || Array.isArray(cap)) return { ok: false, errors: ['not_an_object'], present: true };
  if (cap.version !== STAMP_VERSION) errors.push('version');
  for (const k of Object.keys(cap)) {
    if (k === 'version') continue;
    if (!CAPABILITIES.includes(k)) { errors.push('unknown_capability:' + k); continue; }
    const e = cap[k];
    if (!e || typeof e !== 'object') { errors.push(k + ':not_an_object'); continue; }
    if (!CAPABILITY_STATE.includes(e.state)) errors.push(k + ':state');
    if (e.state && e.state !== 'absent') {
      if (typeof e.decidedBy !== 'string' || !e.decidedBy) errors.push(k + ':decidedBy');
      if (e.decidedAt === undefined || e.decidedAt === null || e.decidedAt === '') errors.push(k + ':decidedAt');
      if (!STAMP_SOURCE.includes(e.source)) errors.push(k + ':source');
    }
  }
  return { ok: errors.length === 0, errors, present: true };
}
function stampedState(cap, capability) {
  const e = cap && cap[capability];
  return e && CAPABILITY_STATE.includes(e.state) ? e.state : 'absent';
}

/* ── Observation ──────────────────────────────────────────────────────────── */
const _status = (d) => String(d && d.status != null ? d.status : '').trim().toLowerCase();
const _looksLive = (d) => !!d && d.active !== false && d.suspended !== true && scope.LIVE_STATUSES.includes(_status(d));
const _appStatus = (a) => String((a && (a.statusCanonical || a.status)) || '').trim().toLowerCase();
const _appRole = (a) => String((a && a.role) || '').trim().toLowerCase();

function _registryFact(doc, live) {
  if (!doc) return 'absent';
  if (live) return 'live';
  if (_looksLive(doc)) return 'status_live_no_approval_evidence';
  return 'present_not_live';
}

/**
 * observe(records) → what production currently CONTAINS. Nothing is inferred.
 * @param {object}   r
 * @param {object}  [r.seller]        sellers/{uid} or null
 * @param {object}  [r.provider]      providers/{uid} or null
 * @param {object[]|null} [r.applications]  the owner's applications, or null when not loaded
 * @param {object}  [r.business]      businesses/{id} or null
 * @param {object}  [r.shop]          shops/{id} or null
 * @param {number|null} [r.productCount]   attached products, or null when not counted
 */
function observe(r = {}) {
  const sc = scope.resolveBusinessScope({ seller: r.seller || null, provider: r.provider || null });
  const apps = Array.isArray(r.applications) ? r.applications : null;
  const byState = { approved: new Set(), pending: new Set(), rejected: new Set() };
  if (apps) for (const a of apps) {
    const cap = ROLE_TO_CAPABILITY[_appRole(a)]; if (!cap) continue;
    const st = _appStatus(a);
    if (st === 'approved') byState.approved.add(cap);
    else if (st === 'pending' || st === 'pending_review' || st === 'under_review' || st === 'request_info') byState.pending.add(cap);
    else if (st === 'rejected') byState.rejected.add(cap);
  }
  const stamp = r.business && r.business.capabilities !== undefined ? r.business.capabilities : null;
  return {
    seller:   _registryFact(r.seller || null, sc.sellsProducts),
    provider: _registryFact(r.provider || null, sc.providesServices),
    reasons:  sc.reasons,
    applications: apps ? { loaded: true, approved: [...byState.approved], pending: [...byState.pending], rejected: [...byState.rejected] } : { loaded: false, approved: [], pending: [], rejected: [] },
    business: r.business ? 'present' : 'absent',
    shop:     r.shop ? 'present' : 'absent',
    productCount: typeof r.productCount === 'number' ? r.productCount : null,
    stamp,
    live: { PRODUCTS: sc.sellsProducts, SERVICES: sc.providesServices },
  };
}

/* ── Proposal ─────────────────────────────────────────────────────────────── */
function _classify(set) {
  const p = set.has(CAPABILITY.PRODUCTS), s = set.has(CAPABILITY.SERVICES);
  if (p && s) return CLASSIFICATION.PRODUCTS_AND_SERVICES;
  if (p) return CLASSIFICATION.PRODUCTS;
  if (s) return CLASSIFICATION.SERVICES;
  return CLASSIFICATION.UNCLASSIFIED;
}

/**
 * propose(observed) → { classification, proposed, authorityStatus, conflicts, notes }
 * With a VALID stamp the stamp is the authority and observation is checked against it.
 * Without one the proposal is what observation supports, marked NOT_YET_STAMPED.
 * Any conflict makes the classification CONFLICT: a business whose records disagree
 * is not routable until a human resolves it.
 */
function propose(o) {
  const conflicts = [], notes = [];
  const liveSet = new Set(CAPABILITIES.filter((c) => o.live[c]));

  /* registry vs approval evidence */
  if (o.seller === 'status_live_no_approval_evidence') conflicts.push({ code: 'seller_status_without_approval', detail: 'sellers doc says active/approved but carries no protected approval evidence (client-writable status)' });
  if (o.provider === 'status_live_no_approval_evidence') conflicts.push({ code: 'provider_status_without_approval', detail: 'providers doc says active/approved but carries no protected approval evidence' });

  /* approval vs projection, only when applications were actually loaded */
  if (o.applications.loaded) {
    for (const cap of o.applications.approved) if (!o.live[cap]) conflicts.push({ code: 'approval_without_projection', capability: cap, detail: 'an approved application exists but the registry document is not live' });
    for (const cap of CAPABILITIES) if (o.live[cap] && !o.applications.approved.includes(cap)) notes.push({ code: 'projection_without_application', capability: cap, detail: 'registry is live with no approved application among those loaded (pre-application-era record, or approved by another path)' });
  }
  /* products attached to a business that cannot sell them */
  if (o.productCount !== null && o.productCount > 0 && !o.live.PRODUCTS) conflicts.push({ code: 'products_without_products_capability', detail: o.productCount + ' product(s) attached, PRODUCTS not live' });

  /* the stamp */
  const v = validateStamp(o.stamp);
  let authorityStatus, classification, proposed;
  if (v.present && v.ok) {
    authorityStatus = AUTHORITY.STAMPED;
    const stampedSet = new Set(CAPABILITIES.filter((c) => stampedState(o.stamp, c) === 'approved'));
    for (const c of CAPABILITIES) if (stampedSet.has(c) !== liveSet.has(c)) conflicts.push({ code: 'stamp_disagrees_with_registry', capability: c, detail: 'stamp says ' + stampedState(o.stamp, c) + ', registry is ' + (liveSet.has(c) ? 'live' : 'not live') });
    proposed = Object.fromEntries(CAPABILITIES.map((c) => [c, stampedState(o.stamp, c)]));
    classification = conflicts.length ? CLASSIFICATION.CONFLICT : _classify(stampedSet);
  } else if (v.present && !v.ok) {
    authorityStatus = AUTHORITY.INVALID_STAMP;
    conflicts.push({ code: 'stamp_invalid', detail: v.errors.join(',') });
    proposed = Object.fromEntries(CAPABILITIES.map((c) => [c, 'absent']));
    classification = CLASSIFICATION.CONFLICT;
  } else {
    authorityStatus = AUTHORITY.NOT_YET_STAMPED;
    proposed = Object.fromEntries(CAPABILITIES.map((c) => [c, liveSet.has(c) ? 'approved' : (o.applications.pending.includes(c) ? 'pending' : 'absent')]));
    classification = conflicts.length ? CLASSIFICATION.CONFLICT : _classify(liveSet);
  }
  return { classification, proposed, authorityStatus, conflicts, notes, observed: o };
}

/** One call: records in, read-model out. */
function readModel(records) { return propose(observe(records)); }

/* ── The routing contract ─────────────────────────────────────────────────── */
/* What each ROUTABLE classification means for the existing surfaces. These are the
   existing premium implementations, named — no redesign. UNCLASSIFIED and CONFLICT
   route NOWHERE: null with a reason, never a default to provider or product. */
const ROUTING = Object.freeze({
  [CLASSIFICATION.PRODUCTS]:              Object.freeze({ storefront: 'product',  card: 'product',  dashboard: 'merchant-v2',        servicesWorkspace: false }),
  [CLASSIFICATION.SERVICES]:              Object.freeze({ storefront: 'provider', card: 'provider', dashboard: 'provider-dashboard', servicesWorkspace: false }),
  [CLASSIFICATION.PRODUCTS_AND_SERVICES]: Object.freeze({ storefront: 'both',     card: 'both',     dashboard: 'merchant-v2',        servicesWorkspace: true  }),
});
function resolveRouting(classification) {
  const r = ROUTING[classification];
  if (r) return Object.assign({ classification, routable: true }, r);
  return { classification, routable: false, storefront: null, card: null, dashboard: null, servicesWorkspace: false,
    reason: classification === CLASSIFICATION.CONFLICT ? 'records disagree; a human must resolve before routing' : 'no approved capability; nothing to route to' };
}

module.exports = {
  CAPABILITY, CAPABILITIES, CAPABILITY_STATE, STAMP_SOURCE, STAMP_VERSION,
  CLASSIFICATION, ROUTABLE, AUTHORITY, ROLE_TO_CAPABILITY, ROUTING,
  validateStamp, stampedState, observe, propose, readModel, resolveRouting,
};
