'use strict';
/**
 * SOKONI — what KIND of healthcare provider an account is  (CHANGELOG 227)
 * ============================================================================================
 * The category-aware Healthcare dashboards, directory and capability matrix need one fact the
 * platform never recorded: is this approved health provider a clinician, a facility, a pharmacy,
 * a laboratory, a telemedicine provider or a home-care provider? `projectProvider` wrote only
 * free-text `category` / `categories`, which the provider can edit — so nothing could be keyed on
 * it without letting a clinic re-file itself as a pharmacy.
 *
 * This is an ATTRIBUTE of the canonical provider identity (providers/{uid}.healthcare), not a new
 * identity or authority:
 *   · SET BY THE SERVER, at the moment AdminOS approves a `health` application
 *     (application-lifecycle.projectProvider), derived ONLY from an unambiguous exact match on
 *     what the applicant chose (hub-register.js business ids, provider-onboarding.js professions);
 *   · or SET BY AN ADMINISTRATOR in AdminOS (healthcare-admin.healthAdminClassify, audited) — the
 *     only way to reach `telemedicine` / `home_care` (no intake form offers them) or to resolve an
 *     ambiguous / unknown application;
 *   · NEVER set by the provider: firestore.rules protects the field on create and update.
 * An application that maps to nothing (or to two categories) is left UNCLASSIFIED (null) and
 * surfaces in AdminOS — it is never guessed.
 */

const CATEGORIES = Object.freeze(['clinician', 'facility', 'pharmacy', 'laboratory', 'telemedicine', 'home_care']);
const LABELS = Object.freeze({
  clinician: 'Doctor / Clinician', facility: 'Clinic / Hospital / Facility', pharmacy: 'Pharmacy',
  laboratory: 'Laboratory', telemedicine: 'Telemedicine provider', home_care: 'Home health / Home care',
});

/* hub-register.js HEALTHCARE business ids → category (exact ids, lines 41-48). */
const FROM_BUSINESS_ID = Object.freeze({
  hospital: 'facility', dental: 'facility', optician: 'facility', physiotherapy: 'facility',
  'mental-health': 'facility', vet: 'facility',
  pharmacy: 'pharmacy', laboratory: 'laboratory',
});
/* provider-onboarding.js 'Healthcare' professions (line 134) → clinician. Individuals, not premises. */
const CLINICIAN_PROFESSIONS = Object.freeze(['doctor', 'nurse', 'clinical officer', 'dentist', 'therapist', 'physiotherapist', 'nutritionist']);

const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The category an application states, or null. Exact matches only; two different answers → null.
 * @returns {string|null}
 */
function categoryFromApplication(app) {
  const a = app || {};
  const found = new Set();
  for (const v of [a.category, a.businessCategory, a.categoryId, a.type]) {
    const k = _norm(v);
    if (Object.prototype.hasOwnProperty.call(FROM_BUSINESS_ID, k)) found.add(FROM_BUSINESS_ID[k]);
  }
  for (const v of [a.subcategory, a.professionalType, a.profession, a.categoryLabel]) {
    if (CLINICIAN_PROFESSIONS.includes(_norm(v))) found.add('clinician');
  }
  return found.size === 1 ? [...found][0] : null;
}

function isCategory(c) { return CATEGORIES.includes(String(c || '')); }

/** The provider's category as the server recorded it (never a free-text field). */
function categoryOf(providerDoc) {
  const h = providerDoc && providerDoc.healthcare;
  return h && isCategory(h.category) ? h.category : null;
}

module.exports = { CATEGORIES, LABELS, FROM_BUSINESS_ID, CLINICIAN_PROFESSIONS, categoryFromApplication, isCategory, categoryOf };
