'use strict';
/**
 * THE Legal Hub taxonomy — ONE source of truth (Legal Hub L1, owner brief 2026-10-03).
 *
 * Six public groups × five services. Every Legal surface reads THIS list:
 *   server  — registerLegalProvider / legalUpdateProfile (practiceAreas validation), getLegalProviders filters,
 *             the providerServices `legalArea` field;
 *   browser — the GENERATED copy sokoni-legal-taxonomy.js (node scripts/build-legal-taxonomy.js; never hand-edit);
 *             legal-hub.html filters + registration, provider dashboard service editor, AdminOS / Super Admin.
 *
 * Ids are stable, lowercase, hyphenated. Labels may change; ids may not (they are stored on profiles + services).
 *
 * LEGACY: profiles written before L1 carry `specializations` from the old 15-value list. They stay valid and are
 * kept as written. LEGACY_TO_AREA maps a legacy value onto a new service ONLY where the match is one-to-one;
 * the rest (criminal_law, immigration, tax_law, property_law, corporate_law, other) map to nothing rather than
 * to a guess — an advocate is never listed under a practice area they did not choose. Whether criminal law,
 * immigration and tax join the public taxonomy is an OWNER decision (docs/LEGAL_HUB_CONVERGENCE.md §Open).
 */

const GROUPS = Object.freeze([
  { id: 'individuals', label: 'Individuals', icon: '👨‍👩‍👧', services: [
    { id: 'family-law', label: 'Family Law' },
    { id: 'employment-law', label: 'Employment Law' },
    { id: 'wills-succession', label: 'Wills & Succession' },
    { id: 'civil-matters', label: 'Civil Matters' },
    { id: 'debt-recovery', label: 'Debt Recovery' },
  ] },
  { id: 'businesses', label: 'Businesses', icon: '🏢', services: [
    { id: 'company-registration', label: 'Company Registration' },
    { id: 'contracts-agreements', label: 'Contracts & Agreements' },
    { id: 'employment-policies', label: 'Employment Policies' },
    { id: 'regulatory-compliance', label: 'Regulatory Compliance' },
    { id: 'intellectual-property', label: 'Intellectual Property' },
  ] },
  { id: 'property-land', label: 'Property & Land', icon: '🏡', services: [
    { id: 'title-search', label: 'Title Search' },
    { id: 'sale-purchase-agreements', label: 'Sale & Purchase Agreements' },
    { id: 'leases-tenancies', label: 'Leases & Tenancies' },
    { id: 'land-disputes', label: 'Land Disputes' },
    { id: 'property-due-diligence', label: 'Property Due Diligence' },
  ] },
  { id: 'dispute-resolution', label: 'Dispute Resolution', icon: '⚖️', services: [
    { id: 'mediation', label: 'Mediation' },
    { id: 'arbitration', label: 'Arbitration' },
    { id: 'negotiation', label: 'Negotiation' },
    { id: 'settlement-support', label: 'Settlement Support' },
    { id: 'litigation-support', label: 'Litigation Support' },
  ] },
  { id: 'documents', label: 'Documents', icon: '📄', services: [
    { id: 'ndas', label: 'NDAs' },
    { id: 'power-of-attorney', label: 'Power of Attorney' },
    { id: 'document-contracts', label: 'Contracts' },
    { id: 'affidavits', label: 'Affidavits' },
    { id: 'custom-documents', label: 'Custom Documents' },
  ] },
  { id: 'startups-sme', label: 'Startups & SME', icon: '🚀', services: [
    { id: 'business-structure', label: 'Business Structure' },
    { id: 'shareholder-agreements', label: 'Shareholder Agreements' },
    { id: 'term-sheets', label: 'Term Sheets' },
    { id: 'legal-advisory', label: 'Legal Advisory' },
    { id: 'growth-support', label: 'Growth Support' },
  ] },
].map((g) => Object.freeze(Object.assign({}, g, { services: Object.freeze(g.services.map((s) => Object.freeze(s))) }))));

const AREA = Object.freeze(GROUPS.reduce((m, g) => { g.services.forEach((s) => { m[s.id] = Object.freeze({ id: s.id, label: s.label, group: g.id }); }); return m; }, {}));
const AREA_IDS = Object.freeze(Object.keys(AREA));

/* SPECIALIST practice areas (owner decision 2026-10-03): criminal law, immigration and tax are added as SEPARATELY
   CONFIGURED services — NOT appended to the 30. Each carries its own eligibility rule: an advocate may REQUEST it, but it is
   public, filterable and usable on a rate card only once SOKONI (AdminOS) CONFIRMS it for that advocate
   (legalProviders.specialistConfirmed, written only by legal-verification _adminH.legalAdminConfirmSpecialist). */
const SPECIALIST = Object.freeze([
  { id: 'criminal-law', label: 'Criminal Law', icon: '🏛️', eligibility: 'admin_confirmed', note: 'Criminal defence and representation' },
  { id: 'immigration-law', label: 'Immigration', icon: '🌍', eligibility: 'admin_confirmed', note: 'Visas, permits and citizenship' },
  { id: 'tax-law', label: 'Tax Law', icon: '🧾', eligibility: 'admin_confirmed', note: 'Tax advisory, disputes and compliance' },
].map((x) => Object.freeze(x)));
const SPECIALIST_IDS = Object.freeze(SPECIALIST.map((x) => x.id));
const isSpecialist = (id) => SPECIALIST_IDS.indexOf(String(id || '')) > -1;
function normalizeSpecialist(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) { const id = typeof v === 'string' ? v.trim().toLowerCase() : ''; if (isSpecialist(id) && out.indexOf(id) < 0) out.push(id); }
  return out;
}
/* Legacy profiles that carried these specialisations are mapped to a REQUEST (never to a confirmed area). */
const LEGACY_TO_SPECIALIST = Object.freeze({ criminal_law: 'criminal-law', immigration: 'immigration-law', tax_law: 'tax-law' });
function specialistRequestedOf(p) {
  const own = normalizeSpecialist(p && p.specialistRequested);
  (p && Array.isArray(p.specializations) ? p.specializations : []).forEach((s) => { const a = LEGACY_TO_SPECIALIST[s]; if (a && own.indexOf(a) < 0) own.push(a); });
  return own;
}
/** What may be shown publicly: CONFIRMED and still requested. */
function specialistConfirmedOf(p) {
  const req = specialistRequestedOf(p);
  return normalizeSpecialist(p && p.specialistConfirmed).filter((a) => req.indexOf(a) > -1);
}

/* Old 15-value list (legal-hub.js before L1). One-to-one matches only. */
const LEGACY_TO_AREA = Object.freeze({
  family_law: 'family-law', employment_law: 'employment-law', debt_recovery: 'debt-recovery',
  intellectual_property: 'intellectual-property', mediation: 'mediation', litigation: 'litigation-support',
  conveyancing: 'sale-purchase-agreements', drafting: 'custom-documents',
  property_law: null, corporate_law: null, criminal_law: null, immigration: null, tax_law: null, notary: null, other: null,
});
const LEGACY_SPECIALIZATIONS = Object.freeze(Object.keys(LEGACY_TO_AREA));

const MAX_AREAS = 12;

/** Validate a client list of practice-area ids. Unknown values are DROPPED (not mapped, not guessed). */
function normalizeAreas(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) {
    const id = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (AREA[id] && out.indexOf(id) < 0) out.push(id);
    if (out.length >= MAX_AREAS) break;
  }
  return out;
}

/** The canonical areas a stored profile stands for: its own practiceAreas, else the one-to-one legacy mapping. */
function areasOfProfile(p) {
  const own = normalizeAreas(p && p.practiceAreas);
  if (own.length) return own;
  const out = [];
  for (const s of (p && Array.isArray(p.specializations) ? p.specializations : [])) {
    const a = LEGACY_TO_AREA[s];
    if (a && out.indexOf(a) < 0) out.push(a);
  }
  return out;
}

function groupOf(areaId) { return AREA[areaId] ? AREA[areaId].group : null; }
function groupsOf(areas) { const g = []; (areas || []).forEach((a) => { const x = groupOf(a); if (x && g.indexOf(x) < 0) g.push(x); }); return g; }
function isArea(id) { return !!AREA[id]; }
function isGroup(id) { return GROUPS.some((g) => g.id === id); }

module.exports = { GROUPS, AREA, AREA_IDS, LEGACY_TO_AREA, LEGACY_SPECIALIZATIONS, MAX_AREAS,
  normalizeAreas, areasOfProfile, groupOf, groupsOf, isArea, isGroup,
  SPECIALIST, SPECIALIST_IDS, LEGACY_TO_SPECIALIST, isSpecialist, normalizeSpecialist, specialistRequestedOf, specialistConfirmedOf };
