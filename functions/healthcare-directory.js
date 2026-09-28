'use strict';
/**
 * SOKONI — the public Healthcare directory  (CHANGELOG 229)
 * ============================================================================================
 * The ONE source for "which healthcare providers can a patient find". It lists ONLY canonical
 * providers/{uid} records (the identity AdminOS approval creates — application-lifecycle,
 * ADR-014) that are:
 *   · classified by the SERVER as healthcare (providers/{uid}.healthcare.category — CHANGELOG 227),
 *     so an unclassified or self-described "clinic" is never listed;
 *   · approved and live (status active|approved, not suspended, public, searchable).
 * It returns a PUBLIC projection — never phone, email, street location, licence, reviewer or any
 * internal field — and a rating only when the reputation authority derived it (repV). There is no
 * seed, sample or fallback: zero approved providers is an empty directory.
 *
 * healthcare.html replaced its hardcoded PROVIDERS / SPECIALISTS / TC_DOCTORS / LAB_TESTS arrays
 * (real institution names with invented ratings, fees and WhatsApp numbers) with this.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const HCAT = require('./healthcare-category');

const CF_OPTS = { region: 'us-central1', enforceAppCheck: true };
const _db = () => admin.firestore();
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);

/** Is this provider publicly discoverable as a healthcare provider? */
/* CHANGELOG 244 (C3a-2): the ONE public-eligibility predicate (business-category.publicEligibility — the same one the
   search-index gate and the provider directory use), restricted to a HEALTHCARE category. The directory lists under
   HCAT.categoryOf (the healthcare authority's own decision); the two must agree or the provider is not listed. */
function isDiscoverable(p) {
  if (!p) return false;
  const elig = require('./business-category').publicEligibility(p);
  return elig.eligible && HCAT.isCategory(elig.category) && elig.category === HCAT.categoryOf(p);
}

/** The public projection — a WHITELIST. */
function publicCard(uid, p) {
  const category = HCAT.categoryOf(p);
  const hasRep = p.repV != null && Number(p.reviewCount) > 0 && Number.isFinite(Number(p.rating));
  return {
    providerId: uid,
    name: _san(p.businessName || p.name, 160),
    category, categoryLabel: HCAT.LABELS[category],
    description: _san(p.description, 300),
    city: _san(p.city, 100) || null,
    area: _san(p.area, 120) || null,
    rating: hasRep ? Math.round(Number(p.rating) * 10) / 10 : null,
    reviewCount: hasRep ? Number(p.reviewCount) : 0,
    acceptsBookings: p.acceptsBookings !== false,
  };
}
const PUBLIC_FIELDS = Object.freeze(Object.keys(publicCard('x', { healthcare: { category: 'clinician' } })));

async function listDirectory(db, { category, limit } = {}) {
  const lim = Math.max(1, Math.min(60, parseInt(limit, 10) || 30));
  if (category != null && category !== '' && !HCAT.isCategory(category)) {
    throw new HttpsError('invalid-argument', 'Unknown healthcare category.');
  }
  /* Equality on the server-set category (auto single-field index); status and visibility are
     filtered here so no composite index is needed and nothing unapproved is ever returned. */
  const base = db.collection('providers');
  const q = category ? base.where('healthcare.category', '==', category) : base.where('healthcare.category', 'in', HCAT.CATEGORIES);
  const snap = await q.limit(300).get();
  const rows = snap.docs.filter((d) => isDiscoverable(d.data())).map((d) => publicCard(d.id, d.data()));
  rows.sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name));
  return rows.slice(0, lim);
}

/* Public, unauthenticated read (App Check enforced) — like every directory. */
exports.healthcareDirectory = onCall(CF_OPTS, async (req) => {
  const d = req.data || {};
  const category = d.category == null ? '' : String(d.category);
  const providers = await listDirectory(_db(), { category, limit: d.limit });
  return { category: category || null, providers, categories: HCAT.CATEGORIES.map((c) => ({ id: c, label: HCAT.LABELS[c] })) };
});

module.exports = { healthcareDirectory: exports.healthcareDirectory, listDirectory, isDiscoverable, publicCard, PUBLIC_FIELDS };
