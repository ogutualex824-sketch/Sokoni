'use strict';
/**
 * SOKONI — SERVICE CAPABILITIES: what an APPROVED business can do, finer than its category  (Slice 0, 2026-10-03)
 * ===================================================================================================================
 * The ONE capability engine used by every vertical (Food Hub, Tech Hub, …). It sits UNDER business-workspace.js and
 * beside the two authorities that module already consumes:
 *
 *   approval   shared/approval-remediation.decisionValidity  — an application counts ONLY if it is a VALID approval
 *              (status approved, decided by a resolvable admin account, never self-decided, approving this role)
 *   category   business-category.js                          — WHO the business is (one stamped category, routes)
 *   capability THIS module                                    — WHAT the approved business does (composable)
 *
 * Rules (owner, 2026-10-03):
 *   · APPROVAL COMES FIRST. Capabilities come only from VALID approvals. An application that is pending, refused,
 *     self-decided or decided by a non-admin grants nothing, whatever it says. A category a browser selected grants
 *     nothing.
 *   · CATEGORY DRIVES CAPABILITY, IT DOES NOT AUTHORISE. The approved business type (hub-register id) maps to a set
 *     of capabilities; the approval is what makes them count.
 *   · CAPABILITIES COMPOSE. Approved for phone repair + laptop repair + IT support → ONE workspace with the UNION of
 *     their capabilities and modules, never three dashboards.
 *   · Capabilities are not products. DEVICE_REPAIR, REMOTE_SUPPORT, QUOTE_REQUEST … are facts that switch modules on.
 *     A module whose screen does not exist yet is NOT_IMPLEMENTED (business-workspace), never faked or hidden.
 *
 * Pure: no firebase, no I/O. business-workspace.js reads the applications and the deciders; this module decides.
 */

const CAPABILITIES = Object.freeze({
  /* Tech Hub (owner, 2026-10-03) */
  DEVICE_REPAIR:     { label: 'Device repair', vertical: 'tech' },
  IT_SUPPORT:        { label: 'IT support', vertical: 'tech' },
  NETWORKING:        { label: 'Networking', vertical: 'tech' },
  CCTV_SECURITY:     { label: 'CCTV & security systems', vertical: 'tech' },
  ELECTRONICS:       { label: 'Electronics', vertical: 'tech' },
  POS_BUSINESS_TECH: { label: 'POS & business technology', vertical: 'tech' },
  SOFTWARE_DEV:      { label: 'Software & web development', vertical: 'tech' },
  /* how a service is delivered — composable with any of the above */
  FIELD_SERVICE:     { label: 'Field service', vertical: 'service' },
  ONSITE_SUPPORT:    { label: 'On-site support', vertical: 'service' },
  REMOTE_SUPPORT:    { label: 'Remote support', vertical: 'service' },
  WORKSHOP:          { label: 'Workshop', vertical: 'service' },
  PICKUP_DROP_OFF:   { label: 'Pickup & drop-off', vertical: 'service' },
  QUOTE_REQUEST:     { label: 'Quotes on request', vertical: 'service' },
  DIRECT_BOOKING:    { label: 'Direct booking', vertical: 'service' },
  /* Food Hub (owner, 2026-10-03) — a food business runs on merchant-v2 (business-workspace.ROUTE_OF.restaurant) */
  FOOD_MENU:         { label: 'Menu', vertical: 'food' },
  KITCHEN:           { label: 'Kitchen', vertical: 'food' },
  DRINKS:            { label: 'Drinks', vertical: 'food' },
  CATERING:          { label: 'Catering', vertical: 'food' },
  BAKERY:            { label: 'Bakery', vertical: 'food' },
});
Object.values(CAPABILITIES).forEach((c) => Object.freeze(c));
const KEYS = Object.freeze(Object.keys(CAPABILITIES));

/* Approved business type (the hub-register ids business-category.FROM_BUSINESS_ID already knows, plus the Tech Hub ids
   sokoni-b2 will register) → capabilities. An id that is not here grants no service capability; its category still
   routes as before. Every capability named here must exist in CAPABILITIES (scripts/test-service-capabilities.js). */
const FROM_BUSINESS_ID = Object.freeze({
  'phone-repair':       ['DEVICE_REPAIR', 'WORKSHOP', 'PICKUP_DROP_OFF', 'QUOTE_REQUEST', 'DIRECT_BOOKING'],
  'laptop-repair':      ['DEVICE_REPAIR', 'WORKSHOP', 'PICKUP_DROP_OFF', 'QUOTE_REQUEST', 'DIRECT_BOOKING'],
  'computer-repair':    ['DEVICE_REPAIR', 'WORKSHOP', 'PICKUP_DROP_OFF', 'QUOTE_REQUEST', 'DIRECT_BOOKING'],
  'electronics-repair': ['ELECTRONICS', 'DEVICE_REPAIR', 'WORKSHOP', 'QUOTE_REQUEST'],
  'it-support':         ['IT_SUPPORT', 'REMOTE_SUPPORT', 'ONSITE_SUPPORT', 'QUOTE_REQUEST', 'DIRECT_BOOKING'],
  'networking':         ['NETWORKING', 'FIELD_SERVICE', 'ONSITE_SUPPORT', 'QUOTE_REQUEST'],
  'cctv':               ['CCTV_SECURITY', 'FIELD_SERVICE', 'ONSITE_SUPPORT', 'QUOTE_REQUEST'],
  'pos-support':        ['POS_BUSINESS_TECH', 'ONSITE_SUPPORT', 'REMOTE_SUPPORT', 'QUOTE_REQUEST'],
  'web-developer':      ['SOFTWARE_DEV', 'REMOTE_SUPPORT', 'QUOTE_REQUEST'],
  'software':           ['SOFTWARE_DEV', 'REMOTE_SUPPORT', 'QUOTE_REQUEST'],
  'app-developer':      ['SOFTWARE_DEV', 'REMOTE_SUPPORT', 'QUOTE_REQUEST'],
  'data-entry':         ['REMOTE_SUPPORT', 'QUOTE_REQUEST'],
  'restaurant':         ['FOOD_MENU', 'KITCHEN', 'DRINKS'],
  'fast-food':          ['FOOD_MENU', 'KITCHEN', 'DRINKS'],
  'cafe':               ['FOOD_MENU', 'KITCHEN', 'DRINKS'],
  'food-truck':         ['FOOD_MENU', 'KITCHEN'],
  'bakery':             ['FOOD_MENU', 'BAKERY', 'KITCHEN'],
  'catering':           ['FOOD_MENU', 'CATERING', 'KITCHEN'],
});

/* Capability → the workspace modules it switches on. `provider` = provider-dashboard module keys
   (business-workspace.MODULES); `merchant` = merchant-v2 module keys (MERCHANT_MODULES below). */
const MODULES_OF = Object.freeze({
  DEVICE_REPAIR:     { provider: ['repairs', 'diagnostics', 'supportedDevices'] },
  IT_SUPPORT:        { provider: ['supportTickets'] },
  NETWORKING:        { provider: ['networkProjects', 'siteVisits'] },
  CCTV_SECURITY:     { provider: ['cctvInstallations', 'siteVisits'] },
  ELECTRONICS:       { provider: ['repairs', 'supportedDevices'] },
  POS_BUSINESS_TECH: { provider: ['posSupport'] },
  SOFTWARE_DEV:      { provider: ['projects'] },
  FIELD_SERVICE:     { provider: ['siteVisits'] },
  ONSITE_SUPPORT:    { provider: ['siteVisits'] },
  REMOTE_SUPPORT:    { provider: ['remoteSupport'] },
  WORKSHOP:          { provider: ['repairs'] },
  PICKUP_DROP_OFF:   { provider: ['pickupDropoff'] },
  QUOTE_REQUEST:     { provider: ['leads', 'quotes'] },
  DIRECT_BOOKING:    { provider: ['bookings'] },
  FOOD_MENU:         { merchant: ['menu'] },
  KITCHEN:           { merchant: ['kitchen'] },
  DRINKS:            { merchant: ['drinks'] },
  CATERING:          { merchant: ['catering'] },
  BAKERY:            { merchant: ['menu'] },
});

/* merchant-v2 modules a capability can switch on. `implemented:false` → NOT_IMPLEMENTED with the reason, never shown
   as working. Flipped to true only by the slice that ships the working screen and its server authority. */
const MERCHANT_MODULES = Object.freeze({
  menu:     { label: 'Menu',     implemented: false, why: 'FOOD_HUB_PENDING' },
  kitchen:  { label: 'Kitchen',  implemented: false, why: 'FOOD_HUB_PENDING' },
  drinks:   { label: 'Drinks',   implemented: false, why: 'FOOD_HUB_PENDING' },
  catering: { label: 'Catering', implemented: false, why: 'FOOD_HUB_PENDING' },
});
Object.values(MERCHANT_MODULES).forEach((m) => Object.freeze(m));

const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const isCapability = (c) => Object.prototype.hasOwnProperty.call(CAPABILITIES, String(c || ''));

/** The business ids one application states — the SAME fields business-category.categoryFromApplication reads. */
function businessIdsOf(app) {
  const a = app || {};
  const ids = new Set();
  for (const v of [a.category, a.businessCategory, a.categoryId, a.type]) {
    const k = _norm(v);
    if (k && Object.prototype.hasOwnProperty.call(FROM_BUSINESS_ID, k)) ids.add(k);
  }
  return [...ids].sort();
}

/**
 * Compose capabilities from VALID approvals only.
 * @param {Array<{id, app, valid}>} approvals  each application with the server's validity verdict (decisionValidity)
 * @returns {{ capabilities: string[], sources: Object<string,string[]>, ignored: Array<{id, why}> }}
 */
function compose(approvals) {
  const caps = new Map();
  const ignored = [];
  for (const x of approvals || []) {
    if (!x || x.valid !== true) { ignored.push({ id: x && x.id || null, why: (x && x.why) || 'not_valid_approval' }); continue; }
    const ids = businessIdsOf(x.app);
    if (!ids.length) { ignored.push({ id: x.id || null, why: 'no_capability_mapping' }); continue; }
    for (const bid of ids) for (const c of FROM_BUSINESS_ID[bid]) {
      if (!caps.has(c)) caps.set(c, new Set());
      caps.get(c).add(String(x.id || ''));
    }
  }
  const capabilities = [...caps.keys()].sort();
  const sources = {};
  capabilities.forEach((c) => { sources[c] = [...caps.get(c)].sort(); });
  return { capabilities, sources, ignored };
}

/** The UNION of module keys the capabilities switch on, for one workspace kind ('provider' | 'merchant'). */
function modulesFor(capabilities, kind) {
  const out = new Set();
  for (const c of capabilities || []) {
    if (!isCapability(c)) continue;
    for (const m of ((MODULES_OF[c] || {})[kind] || [])) out.add(m);
  }
  return [...out].sort();
}

module.exports = { CAPABILITIES, KEYS, FROM_BUSINESS_ID, MODULES_OF, MERCHANT_MODULES, isCapability, businessIdsOf, compose, modulesFor };
