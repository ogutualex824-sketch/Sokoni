'use strict';
/**
 * SOKONI — the ONE canonical business CATEGORY authority  (CHANGELOG 236, convergence slice C1)
 * ============================================================================================
 * What kind of business an approved account is: a hotel, a doctor, a plumber, a cyber/IT shop, a pharmacy…
 * Every downstream consumer that must know this — the category-aware workspace (C2), public discovery (C3),
 * registration (C4), subscriptions (C6) — reads it HERE, from `providers/{uid}.business`, instead of keeping
 * its own copy or reading the provider's free-text `category` (which the provider can edit).
 *
 * THE PATTERN IS HEALTHCARE'S (CHANGELOG 227), generalised — not a second, parallel one:
 *   · SET BY THE SERVER at the moment AdminOS approves an application (application-lifecycle.projectProvider),
 *     from an EXACT match on what the applicant chose (hub-register.js business ids; provider-onboarding.js
 *     professions). Two different answers, or none, → UNCLASSIFIED (null). A category is never inferred to make
 *     routing work.
 *   · SET BY AN ADMINISTRATOR in AdminOS (business-category-admin.bizAdminClassify, audited) — the only way to
 *     resolve an unclassified or disputed business.
 *   · NEVER set by the provider: firestore.rules protect `business` on providers (create + update), and even an
 *     admin's raw client write is refused — reclassification is the audited callable only.
 *   · Healthcare's categories ARE categories of this registry; functions/healthcare-category.js keeps its API
 *     and remains the Healthcare view of the same decision (the two fields are written together).
 *
 * THE COMMERCIAL LANE IS NOT RE-DECIDED HERE. `business.lane` is stamped at approval by the EXISTING classifier
 * (provider-hub.classifyDecidedApplication — healthcare / entertainment / plan rate), so no price moves. It is
 * frozen at approval: an approved provider can no longer re-file into a cheaper lane by editing its application
 * (CHANGELOG 236). An admin reclassification changes the CATEGORY, not the lane — aligning lanes with categories
 * is a commercial decision (C6), recorded rather than made here.
 */

const HC = require('./healthcare-category');

/* The categories. `group` is presentation; `authority` names a category owned by an existing specialised
   authority whose own decision it reflects (never overridden here). */
const CATEGORIES = Object.freeze({
  /* Healthcare — the reference pattern (healthcare-category.js) */
  clinician:             { label: 'Doctor / Clinician', group: 'Healthcare', healthcare: true },
  facility:              { label: 'Clinic / Hospital / Facility', group: 'Healthcare', healthcare: true },
  pharmacy:              { label: 'Pharmacy', group: 'Healthcare', healthcare: true },
  laboratory:            { label: 'Laboratory', group: 'Healthcare', healthcare: true },
  telemedicine:          { label: 'Telemedicine provider', group: 'Healthcare', healthcare: true },
  home_care:             { label: 'Home health / Home care', group: 'Healthcare', healthcare: true },
  /* Hospitality */
  hotel:                 { label: 'Hotel / BnB', group: 'Hospitality' },
  restaurant:            { label: 'Restaurant / Food business', group: 'Hospitality' },
  /* Home & professional services */
  trades:                { label: 'Trades & repairs (plumber, electrician…)', group: 'Home services' },
  cleaning:              { label: 'Cleaning & laundry', group: 'Home services' },
  it_services:           { label: 'Cyber / IT services', group: 'Technology' },
  salon:                 { label: 'Salon / Barber / Spa', group: 'Beauty' },
  lawyer:                { label: 'Lawyer / Advocate', group: 'Legal', authority: 'legal-verification' },
  professional_services: { label: 'Professional services', group: 'Professional' },
  education:             { label: 'Education & training', group: 'Education' },
  auto_services:         { label: 'Auto services', group: 'Car' },
  fitness_studio:        { label: 'Fitness studio', group: 'Fitness' },
  service_business:      { label: 'Service business', group: 'Services' },
  /* Entertainment & events */
  artist_creator:        { label: 'Artist / Creator', group: 'Entertainment' },
  event_services:        { label: 'Event services', group: 'Entertainment' },
  event_organizer:       { label: 'Event organizer', group: 'Entertainment', authority: 'event_organizer role' },
  venue:                 { label: 'Venue', group: 'Entertainment' },
  /* Commerce, property, logistics */
  retail_store:          { label: 'Retail store', group: 'Retail' },
  /* Seller categories (owner, 2026-09-28: "extend the category registry deliberately" — not every seller is a
     "retail store"). Each runs on merchant-v2 (business-workspace.ROUTE_OF) with the full commerce backbone; the
     transaction type, not the category, decides the commission (commission-config.js). */
  supermarket:           { label: 'Supermarket / Minimart', group: 'Retail' },
  wholesale:             { label: 'Wholesale & distribution', group: 'Retail' },
  hardware:              { label: 'Hardware & building materials', group: 'Retail' },
  electronics:           { label: 'Electronics & phones', group: 'Retail' },
  fashion:               { label: 'Fashion & clothing', group: 'Retail' },
  agriculture:           { label: 'Agriculture & farm inputs', group: 'Agriculture' },
  property:              { label: 'Property', group: 'Property' },
  delivery:              { label: 'Delivery / Courier', group: 'Logistics', authority: 'driver role' },
});
const KEYS = Object.freeze(Object.keys(CATEGORIES));
const HEALTHCARE = Object.freeze(KEYS.filter((k) => CATEGORIES[k].healthcare));
/* The merchant (goods-selling) categories: retail_store and the seller categories (owner, 2026-09-28). One list, read by
   business-workspace (route merchant-v2, merchant plan catalogue) — never re-listed by a consumer. */
const SELLER_CATEGORIES = Object.freeze(['retail_store', 'supermarket', 'wholesale', 'hardware', 'electronics', 'fashion', 'agriculture']);

/* hub-register.js business ids → category. EVERY id in hub-register.js appears here, either mapped or with
   null + the reason it is left to AdminOS (scripts/test-business-category.js fails on any id missing here). */
const FROM_BUSINESS_ID = Object.freeze({
  /* healthcare — exactly healthcare-category.FROM_BUSINESS_ID */
  ...HC.FROM_BUSINESS_ID,
  bnb: 'hotel', hotel: 'hotel',
  restaurant: 'restaurant', cafe: 'restaurant', 'fast-food': 'restaurant', bakery: 'restaurant', 'food-truck': 'restaurant', catering: 'restaurant',
  butcher: 'retail_store',
  plumbing: 'trades', electrical: 'trades', carpentry: 'trades', painting: 'trades', 'ac-repair': 'trades',
  landscaping: 'trades', moving: 'trades', contractor: 'trades',
  cleaning: 'cleaning', laundry: 'cleaning', 'pest-control': 'cleaning',
  'security-guard': 'service_business',
  'it-support': 'it_services', 'web-developer': 'it_services', software: 'it_services', 'app-developer': 'it_services',
  cctv: 'it_services', 'phone-repair': 'it_services', 'data-entry': 'it_services',
  /* Tech Hub slice 4 (2026-10-03): repair / networking / POS-support ids registered in hub-register.js. Services, not
     goods — never 'electronics' (a merchant-v2 SELLER category). Capabilities: shared/service-capabilities.js. */
  'laptop-repair': 'it_services', 'computer-repair': 'it_services', 'electronics-repair': 'it_services',
  networking: 'it_services', 'pos-support': 'it_services',
  salon: 'salon', spa: 'salon', 'nail-art': 'salon', makeup: 'salon', tatoo: 'salon',
  lawyer: 'lawyer', notary: 'lawyer',
  accounting: 'professional_services', 'tax-consultant': 'professional_services', architect: 'professional_services',
  insurance: 'professional_services', 'insurance-auto': 'professional_services', advertising: 'professional_services',
  'pr-firm': 'professional_services', 'graphic-design': 'professional_services', 'social-media': 'professional_services',
  printing: 'service_business',
  dj: 'artist_creator', mc: 'artist_creator', band: 'artist_creator', comedian: 'artist_creator',
  photographer: 'artist_creator', videographer: 'artist_creator', 'content-creator': 'artist_creator',
  'event-planner': 'event_services',
  venue: 'venue', 'sports-venue': 'venue', 'swimming-pool': 'venue',
  'retail-shop': 'retail_store', 'water-supplier': 'retail_store', 'auto-parts': 'retail_store', 'sports-equipment': 'retail_store',
  /* Owner, 2026-09-28 — the seller categories: each registrable id whose label names the category EXACTLY. */
  supermarket: 'supermarket', wholesale: 'wholesale', hardware: 'hardware', electronics: 'electronics', boutique: 'fashion',
  'agri-input': 'agriculture', farm: 'agriculture', dairy: 'agriculture',
  gym: 'fitness_studio', 'yoga-studio': 'fitness_studio', 'martial-arts': 'fitness_studio', 'dance-fitness': 'fitness_studio', spinning: 'fitness_studio',
  nutrition: 'service_business', coach: 'service_business',
  school: 'education', tutor: 'education', 'online-course': 'education', 'driving-school': 'education',
  mechanic: 'auto_services', 'car-wash': 'auto_services',
  developer: 'property', landlord: 'property', 'property-agent': 'property',
  courier: 'delivery', 'boda-delivery': 'delivery',
  tailor: 'service_business', 'shoe-repair': 'service_business',
  /* Owner, 2026-09-28 (the executed category→dashboard matrix): map to existing categories rather than add new ones. */
  'car-rental': 'auto_services',                                   /* fleet rental: an auto service (bookings) */
  /* Car Hub C3 (sokoni-f3, 2026-10-03): the Car Hub services registrable in hub-register.js. Mapped to EXISTING categories
     (owner 2026-09-28: map, don't add). Vehicle-for-sale inventory is the vehicle-hub authority (Car Hub C4), not merchant-v2. */
  'car-dealer': 'auto_services', 'vehicle-inspection': 'auto_services', 'towing-roadside': 'auto_services',
  'fleet-operator': 'auto_services', 'vehicle-transport': 'auto_services', 'vehicle-tracking': 'auto_services',
  'ntsa-agent': 'professional_services',
  /* CONSTRUCTION convergence (sokoni-f3, 2026-10-03): the construction trades registrable in hub-register.js, mapped to
     EXISTING categories (owner 2026-09-28: map, don't add). Materials suppliers stay 'hardware' (goods → merchant-v2).
     The architect id is namespaced: bare 'architect' already maps to professional_services above. */
  'construction-company': 'trades', 'welding-fabrication': 'trades', 'construction-services': 'trades',
  'construction-transport': 'service_business', 'equipment-rental': 'service_business', 'construction-architect': 'professional_services',
  'football-club': 'service_business', basketball: 'service_business',  /* clubs / academies: bookable services */
  /* B2B suppliers sell goods → merchant-v2. A wholesaler and an importer are distribution (the `wholesale` category,
     2026-09-28); a manufacturer is left `retail_store` — no category names it and one is not guessed. */
  manufacturer: 'retail_store', wholesaler: 'wholesale', importer: 'wholesale',
  /* ADMIN REVIEW ONLY — never self-classified (owner, 2026-09-28). An application is accepted, but the category is
     decided by AdminOS at approval (bizAdminClassify): */
  forex: null, sacco: null, /* licensed financial services (CBK / SASRA): no self-serve listing */
  'car-finance': null,      /* Car Hub C3: lenders / brokers are licensed financial services — AdminOS classifies (same rule) */
  other: null,              /* "Other / General Business": says nothing */
});
/* The registrable ids that are UNCLASSIFIED ON PURPOSE — AdminOS classifies them by hand. Not a gap. */
const ADMIN_REVIEW_ONLY = Object.freeze(Object.keys(FROM_BUSINESS_ID).filter((k) => FROM_BUSINESS_ID[k] === null));

/* provider-onboarding.js SERVICE_CATEGORIES professions (lower-cased) → category. Every profession appears. */
const FROM_PROFESSION = Object.freeze({
  ...Object.fromEntries(HC.CLINICIAN_PROFESSIONS.map((p) => [p, 'clinician'])),
  electrician: 'trades', plumber: 'trades', carpenter: 'trades', painter: 'trades', welder: 'trades', gardener: 'trades',
  'appliance repair': 'trades', hvac: 'trades', mover: 'trades',
  cleaner: 'cleaning', 'pest control': 'cleaning', 'laundry service': 'cleaning', 'dry cleaner': 'cleaning',
  'security guard': 'service_business',
  'cctv installation': 'it_services', 'access control': 'it_services',
  'software developer': 'it_services', 'web designer': 'it_services', 'it support': 'it_services', 'network engineer': 'it_services', 'data analyst': 'it_services',
  'security consultant': 'professional_services', 'graphic designer': 'professional_services',
  'marketing agency': 'professional_services', 'pr consultant': 'professional_services', 'business consultant': 'professional_services',
  accountant: 'professional_services', bookkeeper: 'professional_services',
  architect: 'professional_services', 'interior designer': 'professional_services', 'structural engineer': 'professional_services', 'quantity surveyor': 'professional_services',
  tutor: 'education', 'private teacher': 'education', 'skills trainer': 'education', 'music teacher': 'education', 'language teacher': 'education',
  photographer: 'artist_creator', videographer: 'artist_creator', 'content creator': 'artist_creator', dj: 'artist_creator', mc: 'artist_creator',
  lawyer: 'lawyer', 'legal consultant': 'lawyer', notary: 'lawyer', arbitrator: 'lawyer',
  salon: 'salon', barber: 'salon', 'makeup artist': 'salon', 'nail technician': 'salon', 'spa therapist': 'salon',
  tailor: 'service_business', 'fashion designer': 'service_business',
  'event planner': 'event_services', caterer: 'event_services', decorator: 'event_services', 'sound engineer': 'event_services', 'lighting technician': 'event_services',
  'delivery service': 'delivery', courier: 'delivery', 'freight agent': 'delivery',
  'virtual assistant': 'service_business', copywriter: 'service_business', translator: 'service_business', 'research analyst': 'service_business', 'data entry': 'service_business',
});

/* A role owned by a specialised authority fixes the category family. */
const ROLE_CATEGORY = Object.freeze({ legal: 'lawyer', event_organizer: 'event_organizer', driver: 'delivery' });

const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const isCategory = (c) => Object.prototype.hasOwnProperty.call(CATEGORIES, String(c || ''));

/**
 * The category an APPLICATION states — exact matches only. Returns { category, reason } where category is null
 * (UNCLASSIFIED) when nothing matches, when two fields disagree, or when the answer conflicts with the role the
 * server decided (a `health` application must land in a Healthcare category; a non-health one never may).
 */
function categoryFromApplication(app, decidedRole) {
  const a = app || {};
  const role = _norm(decidedRole || a.role);
  if (ROLE_CATEGORY[role]) return { category: ROLE_CATEGORY[role], reason: 'role:' + role };
  const found = new Set();
  for (const v of [a.category, a.businessCategory, a.categoryId, a.type]) {
    const k = _norm(v);
    if (Object.prototype.hasOwnProperty.call(FROM_BUSINESS_ID, k) && FROM_BUSINESS_ID[k]) found.add(FROM_BUSINESS_ID[k]);
  }
  for (const v of [a.subcategory, a.professionalType, a.profession, a.categoryLabel]) {
    const k = _norm(v);
    if (Object.prototype.hasOwnProperty.call(FROM_PROFESSION, k)) found.add(FROM_PROFESSION[k]);
  }
  if (role === 'seller' && !found.size) return { category: 'retail_store', reason: 'role:seller' };
  if (found.size !== 1) return { category: null, reason: found.size ? 'ambiguous:' + [...found].sort().join('|') : 'no-exact-match' };
  const cat = [...found][0];
  const hcCat = !!CATEGORIES[cat].healthcare;
  if ((role === 'health') !== hcCat) return { category: null, reason: 'role-conflict:' + (role || 'none') + '→' + cat };
  return { category: cat, reason: 'exact' };
}

/** The canonical category of an approved provider record, or null (UNCLASSIFIED / not a business). */
function categoryOf(providerDoc) {
  const p = providerDoc || {};
  const b = p.business;
  if (b && isCategory(b.category)) return b.category;
  /* integrated authorities that predate C1 (their own decisions — read, never overridden): */
  const hc = HC.categoryOf(p);
  if (hc) return hc;
  if (p.legalProviderId && p.provisionedBy === 'legal-verification') return 'lawyer';
  return null;
}

/**
 * Public eligibility, from server facts only: approved/active, not suspended, and CLASSIFIED. An unclassified
 * business is never publicly listed as a category it has not been given (C3 builds discovery on this).
 */
function publicEligibility(providerDoc) {
  const p = providerDoc || {};
  const reasons = [];
  if (!['active', 'approved'].includes(String(p.status || ''))) reasons.push('NOT_ACTIVE');
  if (p.suspended === true || String(p.status || '') === 'suspended') reasons.push('SUSPENDED');
  if (p.searchable === false) reasons.push('NOT_SEARCHABLE');
  /* CHANGELOG 244 (C3a-2): isPublic:false is written by the server on suspension (application-lifecycle) and on Legal
     provisioning, and an owner may set it to hide themselves. Honouring `false` only ever narrows discovery. */
  if (p.isPublic === false) reasons.push('NOT_PUBLIC');
  const category = categoryOf(p);
  if (!category) reasons.push('UNCLASSIFIED');
  return { eligible: reasons.length === 0, category, reasons };
}

/**
 * SHOP public eligibility — the ONE predicate for whether a seller shop may be publicly discovered (owner decision
 * 2026-09-28: "approved seller ≠ discoverable shop"). It is publicEligibility() applied to the CANONICAL `shops/{id}`
 * record — the one shop document owners cannot write status or classification on — plus the shop-only withdrawals:
 * a deactivated account (isVisible:false / deactivated) and a security lock. The category must be the one the SERVER
 * stamped at approval or AdminOS set (`business.source` application | admin); free-text `category` never counts.
 * Search indexing, storefronts, QR/share, category hubs and KASS read shops through this, never a second rule.
 */
function shopEligibility(shopDoc) {
  const s = shopDoc || {};
  const base = publicEligibility(s);
  const reasons = base.reasons.slice();
  if (s.isVisible === false) reasons.push('NOT_VISIBLE');
  if (s.deactivated === true) reasons.push('DEACTIVATED');
  if (s.locked === true) reasons.push('LOCKED');
  const b = s.business;
  const stamped = !!(b && isCategory(b.category) && (b.source === 'application' || b.source === 'admin'));
  if (!stamped && !reasons.includes('UNCLASSIFIED')) reasons.push('UNCLASSIFIED');
  const category = stamped ? b.category : null;
  return { eligible: reasons.length === 0, category, reasons };
}

module.exports = { CATEGORIES, KEYS, HEALTHCARE, SELLER_CATEGORIES, FROM_BUSINESS_ID, FROM_PROFESSION, ROLE_CATEGORY, ADMIN_REVIEW_ONLY,
  isCategory, categoryFromApplication, categoryOf, publicEligibility, shopEligibility, label: (c) => (isCategory(c) ? CATEGORIES[c].label : 'Unclassified') };
