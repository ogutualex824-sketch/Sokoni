'use strict';
/**
 * SOKONI — TECH SERVICE PROFILE: the device / repair / service-mode facts a Tech provider attaches to a service
 * (Tech Hub slice 4b, 2026-10-03, sokoni-b2)
 * ===================================================================================================================
 * providerServices had no place for "which devices, which brands, which repairs, workshop or on-site" — the editor could
 * only write free text. This module is the ONE validator for that block (`providerServices/{id}.techProfile`) and for the
 * repair details a customer gives when booking such a service (`providerBookings/{id}.repairDetails`).
 *
 * Rules:
 *   · CAPABILITY-BOUND. Device fields need DEVICE_REPAIR or ELECTRONICS; each service mode must be a capability the
 *     provider was GRANTED (shared/service-capabilities compose — valid AdminOS approvals only). A browser cannot claim
 *     "on-site" for a workshop-only business.
 *   · CLOSED VOCABULARY for device type, repair type and brand (models stay free text, bounded) — SOKONI had no device
 *     taxonomy; this is the canonical one, built from the brand / device lists the Tech pages already showed.
 *   · NO PRICE HERE. Price stays on the service / rate card and is computed by the booking engine. turnaroundHours is the
 *     provider's stated estimate, displayed as such — never a promise SOKONI computes.
 *
 * Pure: no firebase, no I/O.
 */

const DEVICE_TYPES = Object.freeze({
  phone: 'Phone', tablet: 'Tablet', laptop: 'Laptop', desktop: 'Desktop / PC', tv: 'TV', audio: 'Audio / speakers',
  console: 'Game console', smartwatch: 'Smartwatch', printer: 'Printer', appliance: 'Small appliance', other: 'Other device',
});
const REPAIR_TYPES = Object.freeze({
  diagnostics: 'Diagnostics / inspection', screen: 'Screen / display', battery: 'Battery', charging: 'Charging port / power',
  water: 'Water damage', software: 'Software / OS', data: 'Data recovery / transfer', keyboard: 'Keyboard / trackpad',
  board: 'Motherboard / board-level', camera: 'Camera', audio: 'Speaker / microphone', buttons: 'Buttons / housing',
  network: 'Network / Wi-Fi / SIM', upgrade: 'Upgrade (RAM / storage)', other: 'Other repair',
});
const BRANDS = Object.freeze([
  'Samsung', 'Apple', 'Tecno', 'Infinix', 'Itel', 'Xiaomi', 'Oppo', 'Vivo', 'Realme', 'Huawei', 'Nokia', 'Google',
  'OnePlus', 'Motorola', 'HP', 'Dell', 'Lenovo', 'Asus', 'Acer', 'Microsoft', 'Toshiba', 'LG', 'Sony', 'Hisense',
  'TCL', 'Vitron', 'Canon', 'Epson', 'Other',
]);
const BRAND_SET = new Set(BRANDS.map((b) => b.toLowerCase()));
/* Service modes are capabilities (shared/service-capabilities). Only these describe HOW a service is delivered. */
const MODE_CAPS = Object.freeze(['WORKSHOP', 'ONSITE_SUPPORT', 'FIELD_SERVICE', 'PICKUP_DROP_OFF', 'REMOTE_SUPPORT']);
const DEVICE_CAPS = Object.freeze(['DEVICE_REPAIR', 'ELECTRONICS']);

const LIMITS = Object.freeze({ models: 30, modelLen: 60, areaLen: 120, maxTurnaroundHours: 720, problemLen: 500 });

const _s = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);
const _list = (v) => (Array.isArray(v) ? v : []);
const _uniq = (a) => [...new Set(a)];

class ProfileError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/**
 * Validate a provider-sent techProfile against the capabilities the provider holds.
 * @param {object} input  client data (untrusted)
 * @param {string[]} granted  composed capabilities (workspaceFor().serviceCapabilities)
 * @returns {object} the sanitized techProfile to store
 * @throws {ProfileError} code: NO_TECH_CAPABILITY | DEVICE_CAPABILITY_REQUIRED | MODE_NOT_GRANTED | BAD_VALUE
 */
function sanitizeProfile(input, granted) {
  const g = new Set(_list(granted).map(String));
  const d = input && typeof input === 'object' ? input : {};
  const hasDevice = DEVICE_CAPS.some((c) => g.has(c));
  const grantedModes = MODE_CAPS.filter((c) => g.has(c));
  if (!hasDevice && !grantedModes.length) throw new ProfileError('NO_TECH_CAPABILITY', 'This business has no approved Tech capability.');

  const out = {};
  const deviceTypes = _uniq(_list(d.deviceTypes).map((x) => _s(x, 30).toLowerCase()));
  const repairTypes = _uniq(_list(d.repairTypes).map((x) => _s(x, 30).toLowerCase()));
  const brands = _uniq(_list(d.brands).map((x) => _s(x, 40)));
  const models = _uniq(_list(d.models).map((x) => _s(x, LIMITS.modelLen)).filter(Boolean));
  const deviceFieldsSent = deviceTypes.length || repairTypes.length || brands.length || models.length;
  if (deviceFieldsSent && !hasDevice) throw new ProfileError('DEVICE_CAPABILITY_REQUIRED', 'Device details need an approved device-repair or electronics category.');
  if (deviceTypes.some((x) => !Object.prototype.hasOwnProperty.call(DEVICE_TYPES, x))) throw new ProfileError('BAD_VALUE', 'Unknown device type.');
  if (repairTypes.some((x) => !Object.prototype.hasOwnProperty.call(REPAIR_TYPES, x))) throw new ProfileError('BAD_VALUE', 'Unknown repair type.');
  if (brands.some((x) => !BRAND_SET.has(x.toLowerCase()))) throw new ProfileError('BAD_VALUE', 'Unknown brand.');
  if (models.length > LIMITS.models) throw new ProfileError('BAD_VALUE', 'Too many models (max ' + LIMITS.models + ').');
  if (hasDevice) {
    out.deviceTypes = deviceTypes.sort();
    out.repairTypes = repairTypes.sort();
    /* canonical spelling from the list, not the client's casing */
    out.brands = brands.map((x) => BRANDS.find((b) => b.toLowerCase() === x.toLowerCase())).sort();
    out.models = models;
  }

  const modes = _uniq(_list(d.serviceModes).map((x) => _s(x, 30).toUpperCase()));
  if (modes.some((m) => !MODE_CAPS.includes(m))) throw new ProfileError('BAD_VALUE', 'Unknown service mode.');
  const notGranted = modes.filter((m) => !g.has(m));
  if (notGranted.length) throw new ProfileError('MODE_NOT_GRANTED', 'Not approved for: ' + notGranted.join(', '));
  out.serviceModes = modes.sort();

  if (d.turnaroundHours !== undefined && d.turnaroundHours !== null && d.turnaroundHours !== '') {
    const t = Math.round(Number(d.turnaroundHours));
    if (!Number.isFinite(t) || t < 1 || t > LIMITS.maxTurnaroundHours) throw new ProfileError('BAD_VALUE', 'Turnaround must be 1–' + LIMITS.maxTurnaroundHours + ' hours.');
    out.turnaroundHours = t;
  } else out.turnaroundHours = null;
  out.serviceArea = _s(d.serviceArea, LIMITS.areaLen);
  return out;
}

/**
 * Validate the repair details a customer sends when booking a service that carries a techProfile. Only devices / brands
 * the service declares are accepted; nothing here touches price.
 * @returns {object|null} sanitized repairDetails, or null when the service has no device profile
 */
function sanitizeRepairDetails(input, techProfile) {
  const tp = techProfile || {};
  if (!Array.isArray(tp.deviceTypes) || !tp.deviceTypes.length) return null;
  const d = input && typeof input === 'object' ? input : {};
  const deviceType = _s(d.deviceType, 30).toLowerCase();
  if (!tp.deviceTypes.includes(deviceType)) throw new ProfileError('BAD_VALUE', 'Choose one of the devices this service covers.');
  const brand = _s(d.brand, 40);
  const canonBrand = brand ? BRANDS.find((b) => b.toLowerCase() === brand.toLowerCase()) : '';
  if (brand && (!canonBrand || (tp.brands && tp.brands.length && !tp.brands.includes(canonBrand)))) throw new ProfileError('BAD_VALUE', 'This service does not cover that brand.');
  const repairType = _s(d.repairType, 30).toLowerCase();
  if (repairType && !(tp.repairTypes || []).includes(repairType)) throw new ProfileError('BAD_VALUE', 'This service does not cover that repair.');
  const mode = _s(d.serviceMode, 30).toUpperCase();
  if (mode && !(tp.serviceModes || []).includes(mode)) throw new ProfileError('BAD_VALUE', 'This service is not offered that way.');
  return {
    deviceType, brand: canonBrand || '', model: _s(d.model, LIMITS.modelLen), repairType: repairType || '',
    serviceMode: mode || '', problem: _s(d.problem, LIMITS.problemLen),
  };
}

module.exports = { DEVICE_TYPES, REPAIR_TYPES, BRANDS, MODE_CAPS, DEVICE_CAPS, LIMITS, ProfileError, sanitizeProfile, sanitizeRepairDetails };
