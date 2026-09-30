'use strict';
/**
 * SOKONI — what a Healthcare provider's WORKSPACE offers, by category  (CHANGELOG 233)
 * ============================================================================================
 * One provider dashboard (provider-dashboard.html) serves every Healthcare category. What it shows
 * is decided HERE, on the server, from two facts the provider cannot edit:
 *
 *   category  providers/{uid}.healthcare.category — set by the server at approval or by an admin in
 *             AdminOS (healthcare-category.js, CHANGELOG 227). WHO the practice is.
 *   plan      capability-authority.capabilitiesFor(uid, { hub:'healthcare' }). What it has PAID for.
 *
 * The two are kept apart on purpose. capability-authority's header is explicit that a capability is
 * what a PLAN permits and never who someone is — so the category matrix is NOT declared there as
 * plan keys (a clinician must not be able to BUY a pharmacy's Till). An operation is offered when the
 * category permits it AND, where the operation is commercial, the live plan does too.
 *
 * ── HIDING IS NOT THE GATE ─────────────────────────────────────────────────────────────────
 * Every operation below names the server check that refuses it (`enforcedBy`). The dashboard hides
 * what is not offered so a provider is not shown a dead end — but a crafted call still meets the
 * server check. An operation with no server check yet says so (`enforcedBy: null` + `pending`), and
 * the matrix never offers such an operation to a category that should not have it; it is reported
 * in the certification rather than implied.
 *
 * ── CUSTOMERS / PATIENTS ARE EVERY CATEGORY'S ──────────────────────────────────────────────
 * Every practice has the people who booked it. The roster (providerGetCustomers — built only from the
 * provider's OWN providerBookings, never from clinical records) is offered to every category, the
 * unclassified included, and labelled "Patients" for every Healthcare category (owner decision 2026-09-28).
 *
 * ── BLOCKED, NOT MISSING ───────────────────────────────────────────────────────────────────
 * Quick Charge is BLOCKED (owner decision 2026-09-28: until dual-business 81394d8 lands on this line)
 * and calls/video are NOT AUTHORIZED for Healthcare (no Connect anchor, no TURN relay). Both are
 * returned as explicit refusals with a reason, never silently absent.
 */

const HC = require('./healthcare-category');

/* The category matrix. true = the kind of practice does this. Order is the dashboard order. */
const MATRIX = Object.freeze({
  /* products + inventory (owner, 2026-09-28: "inventory and products also where applicable") ride on the Shop/Till
     identity, so they are offered exactly where a practice keeps a counter — a facility, a pharmacy, a laboratory
     (test kits, consumables) — and never to a solo clinician, a telemedicine or a home-care practice. */
  //                appointments patients records prescriptions posTill products inventory delivery staff homeVisits
  clinician:    Object.freeze({ appointments: true, patients: true, clinicalRecords: true,  prescriptions: true,  posTill: false, products: false, inventory: false, delivery: false, staff: false, homeVisits: false }),
  facility:     Object.freeze({ appointments: true, patients: true, clinicalRecords: true,  prescriptions: true,  posTill: true,  products: true,  inventory: true,  delivery: false, staff: true,  homeVisits: false }),
  pharmacy:     Object.freeze({ appointments: true, patients: true, clinicalRecords: false, prescriptions: false, posTill: true,  products: true,  inventory: true,  delivery: true,  staff: true,  homeVisits: false }),
  laboratory:   Object.freeze({ appointments: true, patients: true, clinicalRecords: true,  prescriptions: false, posTill: true,  products: true,  inventory: true,  delivery: false, staff: true,  homeVisits: false }),
  telemedicine: Object.freeze({ appointments: true, patients: true, clinicalRecords: true,  prescriptions: true,  posTill: false, products: false, inventory: false, delivery: false, staff: false, homeVisits: false }),
  home_care:    Object.freeze({ appointments: true, patients: true, clinicalRecords: true,  prescriptions: false, posTill: false, products: false, inventory: false, delivery: false, staff: true,  homeVisits: true }),
});

/* An approved health provider nobody has classified yet: its own bookings and its own patients —
   nothing that depends on WHAT it is. It surfaces in AdminOS (healthAdminProviders) for a decision. */
const UNCLASSIFIED = Object.freeze({ appointments: true, patients: true, clinicalRecords: false, prescriptions: false, posTill: false, products: false, inventory: false, delivery: false, staff: false, homeVisits: false });

/* The operations that live on the Shop identity. The plan gates REQUESTING a Shop; once a Shop exists it
   survives a lapsed plan (provider-shop.js: "it gates the request, never the survival") — so a practice that
   HAS a Shop keeps operating its Till, products and inventory whatever its plan does. */
const SHOP_OPS = Object.freeze(['posTill', 'products', 'inventory']);

/* Where each operation is refused on the server. `null` = no category gate yet (see `pending`). */
const ENFORCED_BY = Object.freeze({
  appointments:    'functions/booking-service.js (bookable provider) + ent-availability.loadCalendar',
  patients:        'functions/provider-onboarding.js providerGetCustomers (own providerBookings only)',
  clinicalRecords: 'functions/healthcare-hub.js _clinicalBasis (paid clinical booking with that patient)',
  prescriptions:   'functions/healthcare-hub.js _clinicalBasis (paid clinical booking with that patient)',
  posTill:         'functions/provider-shop.js providerRequestShop (healthcare-workspace.allows posTill)',
  products:        'functions/provider-shop.js providerRequestShop (products live on the Shop)',
  inventory:       'functions/provider-shop.js providerRequestShop (the Shop carries the inventory)',
  delivery:        null,
  staff:           null,
  homeVisits:      null,
});
/* Honest gaps — each is closed by a later commit in this slice, or reported in certification. */
const PENDING = Object.freeze({
  delivery:      'Pharmacy delivery is wired in a later commit of this slice.',
  staff:         'Healthcare staff (least-privilege) is wired in a later commit of this slice.',
  homeVisits:    'Label only — a home visit is an appointment at the patient\'s address.',
  clinicalRecords: 'The server gate is the paid clinical booking, not the category. Scope of practice (who may prescribe) is a professional-licence question, not decided here.',
  prescriptions:   'The server gate is the paid clinical booking, not the category. Scope of practice (who may prescribe) is a professional-licence question, not decided here.',
});

/* Commercial operations additionally need the LIVE plan. The Shop is an identity, so the plan gates
   the REQUEST (shopRequestable), never the survival of a shop already provisioned (provider-shop.js). */
const PLAN_GATED = Object.freeze({ posTill: 'shopRequestable', products: 'shopRequestable', inventory: 'shopRequestable' });

const BLOCKED = Object.freeze({
  quickCharge: 'Quick Charge is not available for Healthcare yet.',
  calls: 'Calls and video with healthcare providers are not available on SOKONI yet.',
});

const CLINICAL = Object.freeze(['clinician', 'facility', 'laboratory', 'telemedicine', 'home_care']);

function matrixFor(category) {
  return HC.isCategory(category) ? MATRIX[category] : UNCLASSIFIED;
}

/**
 * Pure: does this category + capability set offer `op`? Unknown ops are refused.
 * @param {string|null} category
 * @param {object} capabilities  capability-authority capabilities
 * @param {string} op
 */
function allows(category, capabilities, op) {
  const m = matrixFor(category);
  if (!Object.prototype.hasOwnProperty.call(m, op) || m[op] !== true) return false;
  const planKey = PLAN_GATED[op];
  if (planKey) return !!(capabilities && capabilities[planKey] === true);
  return true;
}

/* Dashboard sections (provider-dashboard.html data-hc-section keys) offered to a Healthcare account.
   Entertainment-only sections (rate cards, the booking-PIN page, call requests, booked-hours, the
   followers board) are never listed. */
/* A dashboard section for an operation is listed only once its surface is WIRED — an offered
   operation with no working screen would be a dead end. Later commits in this slice add to this set. */
const WIRED_SECTIONS = Object.freeze([]);
function sectionsFor(category, ops) {
  /* storefront = the public page patients see, its editor and its share link (CHANGELOG 235) */
  const s = ['overview', 'storefront', 'services', 'availability', 'calendar'];
  if (ops.appointments) s.push('bookings');
  s.push('enquiries', 'messages');
  if (ops.patients) s.push('customers');
  for (const [op, sec] of [['posTill', 'pos'], ['products', 'products'], ['inventory', 'inventory'], ['delivery', 'delivery'], ['staff', 'staff']]) {
    if (ops[op] && WIRED_SECTIONS.includes(sec)) s.push(sec);
  }
  s.push('earnings', 'reviews', 'marketing', 'analytics', 'subscription', 'settings');
  return s;
}

/**
 * The workspace for one account. Reads providers/{uid} and the live plan; FAILS CLOSED — an unreadable
 * plan yields the unsubscribed floor, an unreadable provider yields `found:false` and no operations.
 */
async function workspaceFor(db, uid) {
  const snap = await db.collection('providers').doc(String(uid)).get();
  if (!snap.exists) return { found: false, healthcare: false };
  const prov = snap.data() || {};
  const category = HC.categoryOf(prov);
  /* A health provider is one whose record carries the server-written `healthcare` attribute —
     projectProvider stamps it for EVERY approved `health` application, with category null when
     unclassified; firestore.rules forbid the provider writing it (CHANGELOG 227). Free-text `category`
     never makes an account a Healthcare one. */
  const healthcare = !!(prov.healthcare && typeof prov.healthcare === 'object');
  if (!healthcare) return { found: true, healthcare: false };

  let cap = null;
  try { cap = await require('./capability-authority').capabilitiesFor(uid, { hub: 'healthcare' }); }
  catch (_) { cap = null; }
  const capabilities = (cap && cap.capabilities) || require('./capability-authority').UNSUBSCRIBED;

  /* Does this practice already HAVE a Shop? Read from the canonical record, never from the provider's
     `shopId` pointer: providerRequestShop provisions shops/{uid} (no declared id), and `ownerId` is what every
     server-side ownership check reads (application-lifecycle.projectSeller). */
  let hasShop = false;
  try {
    const sh = await db.collection('shops').doc(String(uid)).get();
    hasShop = sh.exists && String((sh.data() || {}).ownerId || '') === String(uid) && String((sh.data() || {}).status || '') === 'active';
  } catch (_) { hasShop = false; }

  const operations = {};
  for (const op of Object.keys(UNCLASSIFIED)) {
    operations[op] = allows(category, capabilities, op)
      /* survival: the category still decides; only the PLAN condition is waived for an existing Shop */
      || (hasShop && SHOP_OPS.includes(op) && matrixFor(category)[op] === true);
  }
  const reasons = {};
  for (const op of Object.keys(operations)) {
    if (operations[op]) continue;
    if (matrixFor(category)[op] && PLAN_GATED[op]) reasons[op] = 'Needs an active Healthcare plan.';
    else if (!category) reasons[op] = 'Awaiting SOKONI classification of your practice.';
    else reasons[op] = 'Not offered for ' + HC.LABELS[category] + '.';
  }
  return {
    found: true, healthcare: true,
    category, classified: !!category, label: category ? HC.LABELS[category] : 'Healthcare provider (awaiting classification)',
    /* Owner decision 2026-09-28: "Patients" for EVERY Healthcare category, pharmacy included. */
    customersLabel: 'Patients',
    plan: { found: !!(cap && cap.found), tier: (cap && cap.tier) || null, status: (cap && cap.status) || 'none' },
    hasShop, operations, reasons,
    blocked: { quickCharge: BLOCKED.quickCharge, calls: BLOCKED.calls },
    sections: sectionsFor(category, operations),
  };
}

/** Throws failed-precondition when `op` is not offered to this account (the server gate). */
async function assertOperation(db, uid, op, HttpsError) {
  const w = await workspaceFor(db, uid);
  if (!w.healthcare || !w.operations || w.operations[op] !== true) {
    const why = (w.reasons && w.reasons[op]) || 'This operation is not available for this account.';
    throw new HttpsError('failed-precondition', why, { code: 'HC_OPERATION_NOT_OFFERED', op, category: w.category || null });
  }
  return w;
}

/* providerDispatch op — the provider's OWN workspace; never another account's. */
const _h = {
  healthcareWorkspace: async (req) => {
    const { HttpsError } = require('firebase-functions/v2/https');
    const uid = req && req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const { getFirestore } = require('firebase-admin/firestore');
    return workspaceFor(getFirestore(), uid);
  },
};

module.exports = { MATRIX, UNCLASSIFIED, SHOP_OPS, ENFORCED_BY, PENDING, PLAN_GATED, BLOCKED, CLINICAL, WIRED_SECTIONS, matrixFor, allows, sectionsFor, workspaceFor, assertOperation, _h };
