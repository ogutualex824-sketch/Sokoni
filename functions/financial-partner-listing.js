/* ══════════════════════════════════════════════════════════════════════════════
   FINANCIAL PARTNER LISTING — the ONE validator for financialProviders/{uid}
   ══════════════════════════════════════════════════════════════════════════════
   Banking Hub directory listings are written by the SERVER only:
     · application-lifecycle.js projects one when an admin approves a
       requestedRole:'financial_partner' application (the ONLY creator), and
     · the partner's own dashboard callable edits the editable subset while the
       listing is approved (sokoni-4d's partnerUpdateListing).
   Both go through this module so the two writers cannot drift apart.

   Every input is applicant-written and therefore untrusted. Nothing is copied
   through: each public field is rebuilt from a validated source, and the
   document carries exactly PUBLIC_KEYS and nothing else.

   WHAT "VERIFIED" MEANS HERE. verifiedBy:'sokoni_admin_review' says a SOKONI
   administrator approved the LISTING. It says nothing about a regulatory
   licence (CBK, SASRA, IRA, CMA …): no licence verification exists, so
   licenceVerified is ALWAYS false and licenceClaimed is self-declared text.
   An applicant who writes licenceVerified:true on their application changes
   nothing, because that field is never read.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const INSTITUTION_TYPES = Object.freeze([
  'BANK', 'SACCO', 'ACCOUNTANT', 'FINANCIAL_ADVISER', 'INSURER',
  'MICROFINANCE', 'INVESTMENT', 'FOREX', 'CHAMA', 'OTHER',
]);

const SERVICES = Object.freeze([
  'BANK_ACCOUNTS', 'BUSINESS_BANKING', 'LOANS', 'MERCHANT_FINANCE', 'SAVINGS',
  'INSURANCE', 'INVESTMENTS', 'FOREX', 'PAYMENTS', 'ACCOUNTING', 'TAX',
  'ADVISORY', 'CHAMA_SERVICES', 'MICROFINANCE',
]);

/* The 47 gazetted counties, canonical spelling. */
const COUNTIES = Object.freeze([
  'Mombasa', 'Kwale', 'Kilifi', 'Tana River', 'Lamu', 'Taita Taveta', 'Garissa',
  'Wajir', 'Mandera', 'Marsabit', 'Isiolo', 'Meru', 'Tharaka Nithi', 'Embu',
  'Kitui', 'Machakos', 'Makueni', 'Nyandarua', 'Nyeri', 'Kirinyaga', "Murang'a",
  'Kiambu', 'Turkana', 'West Pokot', 'Samburu', 'Trans Nzoia', 'Uasin Gishu',
  'Elgeyo Marakwet', 'Nandi', 'Baringo', 'Laikipia', 'Nakuru', 'Narok',
  'Kajiado', 'Kericho', 'Bomet', 'Kakamega', 'Vihiga', 'Bungoma', 'Busia',
  'Siaya', 'Kisumu', 'Homa Bay', 'Migori', 'Kisii', 'Nyamira', 'Nairobi',
]);
const _countyKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const COUNTY_BY_KEY = Object.freeze(COUNTIES.reduce((m, c) => { m[_countyKey(c)] = c; return m; }, {}));

/* The public document's keys — exactly these, nothing else. */
const PUBLIC_KEYS = Object.freeze([
  'uid', 'name', 'institutionType', 'services', 'description', 'county', 'website',
  'businessEmail', 'businessPhone', 'licenceClaimed', 'licenceVerified', 'verifiedBy',
  'listingStatus', 'approvedAt', 'updatedAt', 'applicationId',
]);

/* What a listed partner may change from their dashboard. institutionType and the
   name are identity: changing them needs a new application. */
const EDITABLE_KEYS = Object.freeze(['description', 'services', 'county', 'website', 'businessEmail', 'businessPhone']);

/* Plain text: no markup, no control characters, single-spaced. */
function plainText(v, max) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function institutionType(v) {
  const t = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return INSTITUTION_TYPES.indexOf(t) > -1 ? t : null;
}

/* Unknown entries are dropped, duplicates collapsed, capped at 8. */
function services(v) {
  const list = Array.isArray(v) ? v : [];
  const out = [];
  for (const s of list) {
    const k = typeof s === 'string' ? s.trim().toUpperCase() : '';
    if (SERVICES.indexOf(k) > -1 && out.indexOf(k) < 0) out.push(k);
    if (out.length === 8) break;
  }
  return out;
}

function county(v) {
  return COUNTY_BY_KEY[_countyKey(v)] || null;
}

/* https only, no credentials, no whitespace, ≤200. Anything else is dropped. */
function website(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 200 || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname || u.hostname.indexOf('.') < 0) return null;
  return u.href;
}

function businessEmail(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s.length <= 120 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

/* Kenyan numbers only, normalised to E.164. */
function businessPhone(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  let local = null;
  if (/^0[17]\d{8}$/.test(d)) local = d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) local = d;
  else if (/^254[17]\d{8}$/.test(d)) local = d.slice(3);
  return local ? '+254' + local : null;
}

/**
 * Validate the editable / descriptive fields shared by projection and dashboard edits.
 * Returns { ok, fields, dropped, reason }. `dropped` names optional fields that were
 * supplied but invalid (reported to the admin, never silently "fixed").
 */
function validateDescriptive(src) {
  const s = src || {};
  const dropped = [];
  const fields = {};
  const svc = services(s.services);
  if (!svc.length) return { ok: false, reason: 'no_valid_services', fields: {}, dropped };
  fields.services = svc;
  fields.description = plainText(s.description, 300);
  for (const [k, fn] of [['county', county], ['website', website], ['businessEmail', businessEmail], ['businessPhone', businessPhone]]) {
    const raw = s[k];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = fn(raw);
    if (v) fields[k] = v; else dropped.push(k);
  }
  return { ok: true, fields, dropped };
}

/**
 * Build the approved listing from an application. Pure: no I/O.
 * Returns { ok:true, doc, dropped } or { ok:false, reason }.
 * `doc` holds every PUBLIC_KEY except the timestamps, which the writer stamps.
 */
function buildListing(app, uid, applicationId) {
  const a = app || {};
  const type = institutionType(a.institutionType !== undefined ? a.institutionType : a.category);
  if (!type) return { ok: false, reason: 'invalid_institution_type' };
  const name = plainText(a.institutionName !== undefined ? a.institutionName : a.businessName, 120);
  if (name.length < 2) return { ok: false, reason: 'invalid_institution_name' };
  const d = validateDescriptive(a);
  if (!d.ok) return { ok: false, reason: d.reason };
  const doc = Object.assign({ uid: String(uid), name, institutionType: type }, d.fields);
  const lic = plainText(a.licenceClaimed, 60);
  if (lic) doc.licenceClaimed = lic;
  doc.licenceVerified = false;
  doc.verifiedBy = 'sokoni_admin_review';
  doc.listingStatus = 'approved';
  doc.applicationId = applicationId ? String(applicationId) : null;
  return { ok: true, doc, dropped: d.dropped };
}

const REASONS = Object.freeze({
  invalid_institution_type: 'institutionType must be one of: ' + INSTITUTION_TYPES.join(', ') + '.',
  invalid_institution_name: 'institutionName must be 2 to 120 characters of plain text.',
  no_valid_services: 'services must include at least one of: ' + SERVICES.join(', ') + '.',
});

module.exports = {
  INSTITUTION_TYPES, SERVICES, COUNTIES, PUBLIC_KEYS, EDITABLE_KEYS, REASONS,
  buildListing, validateDescriptive,
  _v: { plainText, institutionType, services, county, website, businessEmail, businessPhone },
};
