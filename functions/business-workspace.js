'use strict';
/**
 * SOKONI — the ONE business WORKSPACE authority  (CHANGELOG 238, convergence C2a)
 * ============================================================================================
 * The browser asks "what workspace am I entitled to?"; this module answers, from server facts only:
 *
 *   C1 category        functions/business-category.categoryOf(providers/{uid})       — WHO the business is
 *   business model     approval state, a Shop the account owns, the creator authority — WHAT it runs
 *   entitlement        functions/capability-authority.capabilitiesFor(uid, { hub })     — what it PAID for
 *
 *   → { category, route, modules: { key: { state, reason } }, blocked, entitlement }
 *
 * The dashboard renders that answer; it never decides. Every module carries ONE of six states (owner decision
 * 2026-09-28), so "not available" and "not relevant" are never the same thing:
 *
 *   AVAILABLE                     authorised AND implemented
 *   LOCKED                        exists, but the subscription / entitlement is missing
 *   NOT_APPLICABLE                this kind of business does not use it
 *   NOT_IMPLEMENTED               the business needs it but no working screen exists yet — never exposed
 *   COMMERCIAL_DECISION_REQUIRED  plan-dependent, and no approved plan mapping exists for this category — never guessed
 *   PENDING_APPROVAL              the business is not eligible yet (not approved, suspended, or UNCLASSIFIED)
 *
 * ROUTES (owner decisions 2026-09-28): the general service-provider model → provider-dashboard (Healthcare, Legal,
 * trades, cleaning, IT, professional, salon, education, auto, fitness, events services, artists' bookings); shops →
 * merchant-v2; food businesses (restaurant) → merchant-v2 too (owner, 2026-09-28); event organisers → event-manager;
 * venues → venue-manager; delivery → the driver app. Hotel and property are UNROUTED — their current pages
 * (bnb-manage, sokoni-property) keep their primary data in the browser and must not be presented as working
 * dashboards. A self-selected onboarding role never routes (537d17e).
 *
 * HEALTHCARE IS ROWS OF THIS AUTHORITY, not a second one: for a Healthcare category the module states come from
 * functions/healthcare-workspace.js (its category matrix and plan intersection, CHANGELOG 233), mapped onto these
 * modules. Plan catalogues are C6's: a category with no approved plan mapping gets base capabilities and
 * COMMERCIAL_DECISION_REQUIRED — never a guessed Premium.
 */

const BCAT = require('./business-category');
/* C2 (capability convergence): the capability authority READ MODEL — PRODUCTS / SERVICES / both, an APPROVED fact
   observed from the registry documents (sellers, providers) and, once it exists, the stamp on businesses/{id}.
   This module CONSUMES it: route = f(category, approved capability). It never derives capability from category,
   and it never writes a capability. See docs/CAPABILITY_AUTHORITY_READ_MODEL.md. */
const CAPS = require('./shared/business-capabilities');

const STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE', LOCKED: 'LOCKED', NOT_APPLICABLE: 'NOT_APPLICABLE', NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  COMMERCIAL_DECISION_REQUIRED: 'COMMERCIAL_DECISION_REQUIRED', PENDING_APPROVAL: 'PENDING_APPROVAL',
});

/* The provider-dashboard modules. `section` is the dashboard's data-hc-section key (provider-dashboard.html) —
   a module is AVAILABLE only if that surface exists (implemented:true). */
const MODULES = Object.freeze({
  overview:      { label: 'Overview',            section: 'overview',     implemented: true },
  storefront:    { label: 'Storefront',          section: 'storefront',   implemented: true },
  services:      { label: 'Services',            section: 'services',     implemented: true },
  availability:  { label: 'Availability',        section: 'availability', implemented: true },
  calendar:      { label: 'Calendar',            section: 'calendar',     implemented: true },
  bookings:      { label: 'Bookings',            section: 'bookings',     implemented: true },
  customers:     { label: 'Customers',           section: 'customers',    implemented: true },
  quotes:        { label: 'Rate cards & quotes', section: 'ratecards',    implemented: true },
  enquiries:     { label: 'Enquiries',           section: 'enquiries',    implemented: true },
  calls:         { label: 'Call requests',       section: 'calls',        implemented: true },
  bookingPin:    { label: 'Verify booking PIN',  section: 'bookingpin',   implemented: true },
  bookedHours:   { label: 'Booked hours',        section: 'bookedhours',  implemented: true },
  messages:      { label: 'Messages',            section: 'messages',     implemented: true },
  marketing:     { label: 'Marketing',           section: 'marketing',    implemented: true },
  reviews:       { label: 'Reviews',             section: 'reviews',      implemented: true },
  earnings:      { label: 'Wallet & earnings',   section: 'earnings',     implemented: true },
  analytics:     { label: 'Analytics',           section: 'analytics',    implemented: true },
  subscription:  { label: 'Plan & subscription', section: 'subscription', implemented: true },
  settings:      { label: 'Settings',            section: 'settings',     implemented: true },
  content:       { label: 'Content & royalties', section: 'content',      implemented: true, route: 'creator-studio.html' },
  /* Needed by some categories, but their screens depend on the deferred SOK-ID business identity (owner,
     2026-09-28) or do not exist — NOT_IMPLEMENTED, never exposed. */
  staff:         { label: 'Staff',               section: 'staff',        implemented: false, why: 'BUSINESS_IDENTITY_PENDING' },
  products:      { label: 'Products',            section: 'products',     implemented: false, why: 'BUSINESS_IDENTITY_PENDING' },
  inventory:     { label: 'Inventory',           section: 'inventory',    implemented: false, why: 'BUSINESS_IDENTITY_PENDING' },
  pos:           { label: 'POS / Till',          section: 'pos',          implemented: false, why: 'BUSINESS_IDENTITY_PENDING' },
  delivery:      { label: 'Delivery',            section: 'delivery',     implemented: false, why: 'BUSINESS_IDENTITY_PENDING' },
  /* Property (owner, 2026-09-28): listings on propertyListings (owner binding 9a48051 / aecf7a7) — the dashboard
     screen is the next build, so it is surfaced as NOT_IMPLEMENTED, never hidden. */
  listings:      { label: 'Listings',            section: 'listings',     implemented: false, why: 'LISTINGS_MODULE_PENDING' },
});
Object.values(MODULES).forEach((m) => Object.freeze(m));   /* each entry too — no caller can flip `implemented` */
const MODULE_KEYS = Object.freeze(Object.keys(MODULES));

/* The modules every approved provider-dashboard business uses. */
const CORE = ['overview', 'storefront', 'services', 'availability', 'calendar', 'bookings', 'customers', 'enquiries',
  'messages', 'marketing', 'reviews', 'earnings', 'analytics', 'subscription', 'settings'];
/* Extra modules per profile (on top of CORE). Anything not listed is NOT_APPLICABLE for that profile. */
const PROFILES = Object.freeze({
  quoted_service:   ['quotes', 'calls', 'bookedHours', 'staff'],                         /* trades, cleaning, IT, professional, lawyer, auto, service */
  appointment_shop: ['calls', 'bookedHours', 'staff', 'products', 'inventory', 'pos'],    /* salon, fitness studio */
  learning:         ['calls', 'bookedHours', 'staff'],                                    /* education */
  entertainment:    ['quotes', 'calls', 'bookingPin', 'bookedHours', 'content', 'staff'], /* artists, event services */
  accommodation:    ['calls', 'staff'],                                                    /* hotel, guesthouse, BnB host */
  property:         ['calls', 'staff', 'listings'],                                        /* agent, developer, landlord (viewings = bookings) */
});
/* Modules a profile NEEDS but whose screen does not yet work for that category — NOT_IMPLEMENTED with the reason,
   never hidden and never faked. Accommodation: a stay is NIGHTS priced per night; the booking engine books minute
   slots (booking-service.js), so selling a "room" through it would book a 30-minute room. Until the stay engine
   lands on the one availability authority, stays are refused server-side (notBuiltFor → bookingCreateService). */
const PROFILE_NOT_BUILT = Object.freeze({
  accommodation: Object.freeze({ bookings: 'STAY_ENGINE_PENDING', availability: 'STAY_ENGINE_PENDING', calendar: 'STAY_ENGINE_PENDING' }),
});
/* What the dashboard banner tells a business whose profile has NOT_BUILT modules — the sidebar hides every module that
   is not AVAILABLE, so without this the missing capability would simply vanish. Plain words, never an internal code. */
const PROFILE_NOTICE = Object.freeze({
  accommodation: 'Room bookings (stays) are being built. Guests can already find your rooms, enquire and message you; SOKONI will switch stays on when they are ready.',
  property: 'Listings management is being built. Clients can already find you, enquire and book viewings; SOKONI will switch listings on when it is ready.',
});
const PROFILE_OF = Object.freeze({
  trades: 'quoted_service', cleaning: 'quoted_service', it_services: 'quoted_service', professional_services: 'quoted_service',
  lawyer: 'quoted_service', auto_services: 'quoted_service', service_business: 'quoted_service',
  salon: 'appointment_shop', fitness_studio: 'appointment_shop',
  education: 'learning',
  artist_creator: 'entertainment', event_services: 'entertainment',
  hotel: 'accommodation',   /* owner 2026-09-28: the provider dashboard + an accommodation profile */
  property: 'property',     /* owner 2026-09-28: the provider dashboard + a Listings module */
});

/* Where each category's workspace lives. null = UNROUTED (owner, 2026-09-28): no working dashboard exists yet. */
const ROUTE_OF = Object.freeze({
  ...Object.fromEntries(BCAT.HEALTHCARE.map((c) => [c, 'provider-dashboard.html'])),
  ...Object.fromEntries(Object.keys(PROFILE_OF).map((c) => [c, 'provider-dashboard.html'])),
  event_organizer: 'event-manager.html',
  venue: 'venue-manager.html',
  retail_store: 'merchant-v2.html',
  /* The seller categories (owner, 2026-09-28) — one commerce workspace, no new dashboard. */
  ...Object.fromEntries(BCAT.SELLER_CATEGORIES.map((c) => [c, 'merchant-v2.html'])),
  /* Owner, 2026-09-28: a food business runs on merchant-v2 — the menu is its products, and orders, POS/Till, Quick
     Charge, delivery, staff and receipts already exist there with server authority. (food-dashboard.html ran on a
     hard-coded restaurant + browser storage.) Approval provisions its shop exactly as retail does: resolveRole makes
     a merchant-v2 category a seller. */
  restaurant: 'merchant-v2.html',
  delivery: 'driver.html',
  /* hotel / property → provider-dashboard.html via PROFILE_OF above (owner, 2026-09-28). bnb-manage.html and the
     sokoni-property dashboards kept their primary data in the browser and are NOT routed to. */
});
/* No category is unrouted today; a future one names its honest message here. */
const UNROUTED_REASON = Object.freeze({});

/* Plan catalogues that exist and are enforced today (capability-authority hubs). Everything else: C6. */
const PLAN_HUB_OF = (category) => (BCAT.HEALTHCARE.includes(category) ? 'healthcare' : (BCAT.SELLER_CATEGORIES.includes(category) ? 'merchant' : null));

function _moduleSet(state, reason) {
  const out = {};
  for (const k of MODULE_KEYS) out[k] = { state, reason: reason || null };
  return out;
}

/**
 * Pure: the module states for an APPROVED, CLASSIFIED provider-dashboard business with no Healthcare row.
 * @param {string} category  a C1 category with a provider-dashboard profile
 * @param {{isCreator?: boolean}} model
 */
function modulesForProfile(category, model) {
  const profile = PROFILE_OF[category];
  const extras = profile ? PROFILES[profile] : [];
  const mods = {};
  for (const k of MODULE_KEYS) {
    const applies = CORE.includes(k) || extras.includes(k);
    if (!applies) { mods[k] = { state: STATE.NOT_APPLICABLE, reason: null }; continue; }
    if (!MODULES[k].implemented) { mods[k] = { state: STATE.NOT_IMPLEMENTED, reason: MODULES[k].why || null }; continue; }
    const notBuilt = profile && PROFILE_NOT_BUILT[profile] && PROFILE_NOT_BUILT[profile][k];
    if (notBuilt) { mods[k] = { state: STATE.NOT_IMPLEMENTED, reason: notBuilt }; continue; }
    if (k === 'content' && !(model && model.isCreator)) { mods[k] = { state: STATE.NOT_APPLICABLE, reason: 'NOT_A_CREATOR' }; continue; }
    mods[k] = { state: STATE.AVAILABLE, reason: null };
  }
  return mods;
}

/**
 * Pure: the reason `module` is NOT BUILT for this provider's category, or null. For server guards on operations that
 * reach a provider from OUTSIDE its dashboard (a customer booking) — e.g. bookingCreateService refuses a minute-slot
 * booking of a hotel room (STAY_ENGINE_PENDING) instead of selling a 30-minute stay.
 */
function notBuiltFor(providerDoc, module) {
  const category = BCAT.categoryOf(providerDoc || {});
  const profile = category ? PROFILE_OF[category] : null;
  return (profile && PROFILE_NOT_BUILT[profile] && PROFILE_NOT_BUILT[profile][module]) || null;
}

/**
 * Pure: a Healthcare category's module states from its healthcare-workspace answer (matrix + plan). An op the
 * category's matrix does not have → NOT_APPLICABLE; one whose screen is not wired → NOT_IMPLEMENTED; one the matrix
 * has but the plan does not unlock → LOCKED. `implementedOf` is injectable so the day a screen is wired can be
 * proven today (scripts/test-business-workspace.js).
 */
function healthcareModules(category, hw, implementedOf) {
  const impl = implementedOf || ((k) => MODULES[k].implemented);
  const HW = require('./healthcare-workspace');
  const modules = _moduleSet(STATE.NOT_APPLICABLE, null);
  for (const k of CORE) modules[k] = { state: STATE.AVAILABLE, reason: null };
  const ops = (hw && hw.operations) || {};
  const opToModule = { posTill: 'pos', products: 'products', inventory: 'inventory', delivery: 'delivery', staff: 'staff', patients: 'customers' };
  const matrix = HW.matrixFor(category);
  for (const [op, mod] of Object.entries(opToModule)) {
    if (!matrix[op]) { modules[mod] = { state: STATE.NOT_APPLICABLE, reason: null }; continue; }
    if (!impl(mod)) { modules[mod] = { state: STATE.NOT_IMPLEMENTED, reason: MODULES[mod].why || null }; continue; }
    modules[mod] = ops[op] ? { state: STATE.AVAILABLE, reason: null } : { state: STATE.LOCKED, reason: (hw && hw.reasons && hw.reasons[op]) || 'PLAN_REQUIRED' };
  }
  return modules;
}

/**
 * The workspace for one account, from server facts only. FAILS CLOSED: an unreadable fact yields fewer modules,
 * never more.
 */
/**
 * The account's capability, from server facts only (C2 read model). READ ONLY. An unreadable fact is reported as
 * unreadable — never as UNCLASSIFIED, which is a different state: `readable:false` routes by the category path
 * exactly as before and says so.
 */
async function capabilityFor(db, uid) {
  try {
    const [s, p, b] = await Promise.all(['sellers', 'providers', 'businesses'].map((c) => db.collection(c).doc(String(uid)).get()));
    const rm = CAPS.readModel({ seller: s.exists ? (s.data() || {}) : null, provider: p.exists ? (p.data() || {}) : null,
      business: b.exists ? (b.data() || {}) : null, applications: null, productCount: null });
    return { readable: true, classification: rm.classification, proposed: rm.proposed, authorityStatus: rm.authorityStatus,
      conflicts: rm.conflicts.map((c) => c.code + (c.capability ? ':' + c.capability : '')), routing: CAPS.resolveRouting(rm.classification) };
  } catch (e) {
    return { readable: false, classification: null, proposed: null, authorityStatus: null, conflicts: [], routing: null, error: String(e && e.message || e) };
  }
}

/* ── R2: THE CATEGORY AUTHORITY'S ANSWER, and its commercial lane ───────────────────────────────────────────
   The category is READ from the stamp C1 wrote at approval — on providers/{uid}.business (or the healthcare
   authority), or on businesses/{uid}.business for a seller approved into a shop — never from application text,
   free-text `category`, or the capability. `lane` says which kind of trade that category is: SELLER_CATEGORIES
   are the products lane; every other C1 category (healthcare included) is the services lane. */
function laneOf(category) {
  if (!category) return null;
  return BCAT.SELLER_CATEGORIES.includes(category) ? 'products' : 'services';
}
function categoryFor(providerDoc, businessDoc) {
  const fromProvider = providerDoc ? BCAT.categoryOf(providerDoc) : null;
  if (fromProvider) return fromProvider;
  const b = businessDoc && businessDoc.business;
  if (b && BCAT.isCategory(b.category) && ['application', 'admin'].includes(String(b.source || ''))) return b.category;
  return null;
}

/* A holding answer: no working dashboard, Overview + Settings only, and the reason named. */
function _holding(state, reason, category, message, extra) {
  const mods = _moduleSet(STATE.PENDING_APPROVAL, reason);
  mods.overview = { state: STATE.AVAILABLE, reason: null };
  mods.settings = { state: STATE.AVAILABLE, reason: null };
  return Object.assign({ found: true, category, label: category ? BCAT.label(category) : 'Awaiting classification', route: null, state, reason,
    message, modules: mods, entitlement: { state: null, hub: null } }, extra || {});
}

/**
 * R2 — route = f(category, capability). Two authorities, BOTH required, neither inferred from the other:
 *
 *   category lane   capability               → route
 *   products        PRODUCTS                 → merchant-v2 (the category's own route)
 *   services        SERVICES                 → the category's route (provider-dashboard, venue-manager, …) + modules
 *   any             PRODUCTS_AND_SERVICES    → merchant-v2 WITH the Services workspace (one business)
 *   products        SERVICES only            → CONFLICT — no route
 *   services        PRODUCTS only            → CONFLICT — no route
 *   none            any routable capability  → PENDING_CLASSIFICATION — no route (the grandfather clause is REMOVED:
 *                                              an approved provider with no category no longer inherits the provider
 *                                              dashboard; AdminOS classifies it, then the contract applies)
 *   any             UNCLASSIFIED             → no route (PENDING_APPROVAL / not found, as before)
 *   any             CONFLICT                 → no route
 *   —               unreadable               → no route (CAPABILITY_UNREADABLE; fail closed, never route on one authority)
 */
async function workspaceFor(db, uid) {
  const capability = await capabilityFor(db, uid);
  const [p, b] = await Promise.all([db.collection('providers').doc(String(uid)).get(), db.collection('businesses').doc(String(uid)).get()]);
  const prov = p.exists ? (p.data() || {}) : null, biz = b.exists ? (b.data() || {}) : null;
  const category = categoryFor(prov, biz);
  const lane = laneOf(category);
  const withCap = (w) => Object.assign(w, { capability, category: w.category === undefined ? category : w.category, lane, servicesWorkspace: w.servicesWorkspace === true });
  const K = CAPS.CLASSIFICATION;

  if (!capability.readable) {
    return withCap(_holding('CAPABILITY_UNREADABLE', 'CAPABILITY_UNREADABLE', category,
      'Your business record could not be read just now. Nothing has changed; please try again shortly.'));
  }
  const cls = capability.classification;

  /* CONFLICT from the read model: a live-looking status with no approval evidence, a stamp that disagrees with the
     registry, a malformed stamp. */
  if (cls === K.CONFLICT) {
    return withCap(_holding('CAPABILITY_CONFLICT', 'CAPABILITY_CONFLICT', category,
      'Your business records need a SOKONI review before your workspace opens.', { conflicts: capability.conflicts }));
  }

  /* UNCLASSIFIED: no approved capability. Not found, or the pre-existing pending / suspended answer — with NO route. */
  if (cls === K.UNCLASSIFIED) {
    if (!prov) {
      return withCap({ found: false, category: null, route: null, state: STATE.PENDING_APPROVAL, reason: 'NO_APPROVED_BUSINESS',
        modules: _moduleSet(STATE.PENDING_APPROVAL, 'NO_APPROVED_BUSINESS'), entitlement: { state: null, hub: null } });
    }
    const suspended = String(prov.status || '') === 'suspended' || prov.suspended === true;
    return withCap(_holding(STATE.PENDING_APPROVAL, suspended ? 'SUSPENDED' : 'NOT_APPROVED', category,
      suspended ? 'Your business is suspended.' : 'Your business is not active yet.', { publicEligibility: BCAT.publicEligibility(prov || {}) }));
  }

  /* An approved capability with NO category: pending classification. AdminOS decides; nothing is inferred. */
  if (!category) {
    return withCap(_holding('PENDING_CLASSIFICATION', 'UNCLASSIFIED', null,
      'SOKONI is confirming what kind of business you are. Your full workspace opens as soon as that is done.'));
  }

  /* The two authorities disagree on what kind of trade this is. */
  if ((lane === 'products' && cls === K.SERVICES) || (lane === 'services' && cls === K.PRODUCTS)) {
    return withCap(_holding('CAPABILITY_CONFLICT', 'CATEGORY_CAPABILITY_DISAGREEMENT', category,
      'Your business records need a SOKONI review before your workspace opens.',
      { conflicts: ['category_capability_disagreement:' + lane + '/' + cls] }));
  }

  /* products lane + PRODUCTS: the category's own route (merchant-v2), whose own authority decides its modules. */
  if (cls === K.PRODUCTS) {
    const route = Object.prototype.hasOwnProperty.call(ROUTE_OF, category) ? ROUTE_OF[category] : null;
    return withCap({ found: true, category, label: BCAT.label(category), route, state: route ? STATE.AVAILABLE : STATE.NOT_IMPLEMENTED,
      reason: route ? null : 'WORKSPACE_NOT_BUILT', modules: _moduleSet(STATE.NOT_APPLICABLE, 'OWN_WORKSPACE'), entitlement: { state: null, hub: 'merchant' } });
  }

  /* services lane + SERVICES, or both: the category path supplies route and module states (unchanged behaviour for a
     valid combination); both capabilities make it ONE business on merchant-v2 with the Services workspace. */
  const w = await _categoryWorkspace(db, uid, prov, category);
  if (cls === K.PRODUCTS_AND_SERVICES) {
    return withCap(Object.assign(w, { route: 'merchant-v2.html', state: STATE.AVAILABLE, reason: null, servicesWorkspace: true }));
  }
  return withCap(w);
}

/* The category path for an APPROVED provider WITH a category: the category's route and the module states. Reached
   only through workspaceFor once both authorities agree. The pre-R2 branches for "no provider", "not approved" and
   the LEGACY grandfather clause ("approved before C1, no category → full provider dashboard", owner 2026-09-28) are
   gone: the owner removed the clause on 2026-09-29 — no category + no authoritative combination = not routable. */
async function _categoryWorkspace(db, uid, prov, category) {
  /* A services-lane category on an account whose provider record is missing cannot happen through workspaceFor
     (the capability would not be SERVICES); guarded anyway — fail closed, never a route on one authority. */
  if (!prov || !category) {
    return _holding('PENDING_CLASSIFICATION', 'UNCLASSIFIED', null,
      'SOKONI is confirming what kind of business you are. Your full workspace opens as soon as that is done.');
  }
  const elig = BCAT.publicEligibility(prov);

  const route = Object.prototype.hasOwnProperty.call(ROUTE_OF, category) ? ROUTE_OF[category] : null;
  const planHub = PLAN_HUB_OF(category);
  let cap = null;
  if (planHub) {
    /* a CALL into the one capability authority — never a second implementation (verify-capability-consumers.js) */
    const CAP = require('./capability-authority');
    try {
      cap = await CAP.capabilitiesFor(uid, { hub: planHub });
    } catch (_) {
      cap = null;
    }
  }
  const entitlement = planHub
    ? { state: cap && cap.found ? 'MAPPED' : 'MAPPED_NO_PLAN', hub: planHub, tier: (cap && cap.tier) || null, status: (cap && cap.status) || 'none' }
    : { state: STATE.COMMERCIAL_DECISION_REQUIRED, hub: null, tier: null, status: null };

  /* UNROUTED categories: approved and classified, but no working workspace exists. */
  if (route === null) {
    const mods = _moduleSet(STATE.NOT_IMPLEMENTED, 'WORKSPACE_NOT_BUILT');
    mods.overview = { state: STATE.AVAILABLE, reason: null };
    mods.settings = { state: STATE.AVAILABLE, reason: null };
    return { found: true, category, label: BCAT.label(category), route: null, state: STATE.NOT_IMPLEMENTED, reason: 'WORKSPACE_NOT_BUILT',
      message: UNROUTED_REASON[category] || null, modules: mods, entitlement, publicEligibility: elig };
  }
  /* Workspaces that live on their own dashboards (merchant-v2, event-manager, venue-manager, driver app): this
     authority names the route; that dashboard's own authority decides its modules. */
  if (route !== 'provider-dashboard.html') {
    return { found: true, category, label: BCAT.label(category), route, state: STATE.AVAILABLE, reason: null,
      modules: _moduleSet(STATE.NOT_APPLICABLE, 'OWN_WORKSPACE'), entitlement, publicEligibility: elig };
  }

  let modules;
  if (BCAT.HEALTHCARE.includes(category)) {
    /* Healthcare rows — the existing matrix + plan intersection (healthcare-workspace, CHANGELOG 233). */
    const w = await require('./healthcare-workspace').workspaceFor(db, uid);
    modules = healthcareModules(category, w);
  } else {
    let isCreator = false;
    try { const c = await db.collection('creators').doc(String(uid)).get(); isCreator = c.exists && String((c.data() || {}).state || '') === 'ACTIVE'; } catch (_) { isCreator = false; }
    modules = modulesForProfile(category, { isCreator });
  }
  const notice = PROFILE_NOTICE[PROFILE_OF[category]] || null;
  return { found: true, category, label: BCAT.label(category), route, state: STATE.AVAILABLE, reason: null, message: notice, modules, entitlement, publicEligibility: elig };
}

/** Throws failed-precondition unless `module` is AVAILABLE for this account — the server gate (C2b). */
async function assertModule(db, uid, module, HttpsError) {
  const w = await workspaceFor(db, uid);
  const m = w.modules && w.modules[module];
  if (!m || m.state !== STATE.AVAILABLE) {
    throw new HttpsError('failed-precondition', 'This is not available for your business.',
      { code: 'WORKSPACE_MODULE_' + ((m && m.state) || 'UNKNOWN'), module, category: w.category || null, reason: (m && m.reason) || w.reason || null });
  }
  return w;
}

/**
 * The gate for an operation on a CALENDAR-scoped provider surface (rate cards, quotes, discounts, availability):
 * a provider calendar (svc_<uid>) must have `module` AVAILABLE; a venue calendar (ven_<id>) belongs to
 * venue-manager's own workspace and is not decided here.
 */
async function gateCalendarModule(db, uid, calKey, module, HttpsError) {
  if (String(calKey || '').startsWith('ven_')) return null;
  return assertModule(db, uid, module, HttpsError);
}
/** The gate for an account-scoped provider setting: applies when the account IS a provider (has a providers doc). */
async function gateIfProvider(db, uid, module, HttpsError) {
  const p = await db.collection('providers').doc(String(uid)).get();
  if (!p.exists) return null;
  return assertModule(db, uid, module, HttpsError);
}

/**
 * HOME (CHANGELOG 240, convergence C2c): every workspace this account ACTUALLY holds, from server facts only —
 * never a self-selected onboarding role (accounts.currentRole), never localStorage, never a free-text category.
 * `workspace.html` is the ONE place every "my dashboard" link goes; it asks this and follows the answer.
 *
 *   providers/{uid}            → the business workspace's route (or UNROUTED: its message)
 *   shops where ownerId == uid → merchant-v2.html (choose-shop.html when there are several)
 *   token.rider                → driver.html          (granted by an approved driver application)
 *   token.event_organizer      → event-manager.html   (granted by an approved organiser application)
 *   creators/{uid} ACTIVE      → creator-studio.html
 *   venues where ownerId == uid, status active → venue-manager.html
 *   none                       → { apply: true }      (Register my business — never a guessed dashboard)
 */
async function homeFor(db, uid, token) {
  const t = token || {};
  const homes = [];
  const add = (h) => { if (!homes.some((x) => x.route === h.route && x.route)) homes.push(h); };
  try {
    const w = await workspaceFor(db, uid);
    if (w.found) {
      add({ kind: 'business', label: w.label || 'My business', category: w.category, state: w.state, route: w.route,
        servicesWorkspace: w.servicesWorkspace === true, capability: w.capability ? w.capability.classification : null,
        message: w.message || (w.state === STATE.PENDING_APPROVAL ? 'Your business is not active yet.' : null) });
    }
  } catch (_) { /* fall through — never invent a workspace */ }
  try {
    const shops = await db.collection('shops').where('ownerId', '==', String(uid)).limit(10).get();
    const active = shops.docs.filter((d) => String((d.data() || {}).status || 'active') !== 'suspended');
    if (active.length) add({ kind: 'shop', label: active.length > 1 ? 'My shops' : ((active[0].data() || {}).name || 'My shop'), route: active.length > 1 ? 'choose-shop.html' : 'merchant-v2.html', state: STATE.AVAILABLE });
  } catch (_) { /* no shop read → no shop home */ }
  if (t.rider === true) add({ kind: 'driver', label: 'Driver app', route: 'driver.html', state: STATE.AVAILABLE });
  if (t.event_organizer === true) add({ kind: 'events', label: 'Event Manager', route: 'event-manager.html', state: STATE.AVAILABLE });
  try {
    const c = await db.collection('creators').doc(String(uid)).get();
    if (c.exists && String((c.data() || {}).state || '') === 'ACTIVE') add({ kind: 'creator', label: 'Creator Studio', route: 'creator-studio.html', state: STATE.AVAILABLE });
  } catch (_) { /* none */ }
  try {
    const v = await db.collection('venues').where('ownerId', '==', String(uid)).limit(5).get();
    if (v.docs.some((d) => String((d.data() || {}).status || '') === 'active')) add({ kind: 'venue', label: 'Venue Manager', route: 'venue-manager.html', state: STATE.AVAILABLE });
  } catch (_) { /* none */ }
  return { homes, apply: homes.length === 0, primary: homes.find((h) => h.route) || null };
}

/* providerDispatch op — the caller's OWN workspace; never another account's. */
const _h = {
  businessWorkspace: async (req) => {
    const { HttpsError } = require('firebase-functions/v2/https');
    const uid = req && req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const { getFirestore } = require('firebase-admin/firestore');
    return workspaceFor(getFirestore(), uid);
  },
  /* C2c: every workspace this account holds — the ONE answer behind workspace.html. Caller-only. */
  workspaceHome: async (req) => {
    const { HttpsError } = require('firebase-functions/v2/https');
    const uid = req && req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const { getFirestore } = require('firebase-admin/firestore');
    return homeFor(getFirestore(), uid, req.auth.token || {});
  },
};

module.exports = { STATE, MODULES, MODULE_KEYS, CORE, PROFILES, PROFILE_OF, PROFILE_NOT_BUILT, ROUTE_OF, modulesForProfile, notBuiltFor, healthcareModules, workspaceFor, capabilityFor, categoryFor, laneOf, homeFor, assertModule, gateCalendarModule, gateIfProvider, _h };
