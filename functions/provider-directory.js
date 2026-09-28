'use strict';
/**
 * SOKONI — the public PROVIDER directory  (CHANGELOG 244, convergence C3a-2)
 * ============================================================================================
 * The ONE server answer to "which providers can the public find, and under which category". Every client hub
 * directory (sokoni-providers.js → providers / services / cleaning / index / provider-profile, and the Firestore
 * search fallback) asks THIS instead of reading `providers` from the browser and re-deciding approval, category,
 * suspension and searchability from whatever fields it could read.
 *
 *   eligibility  functions/business-category.publicEligibility — the SAME predicate the search-index gate
 *                (discovery-eligibility.prepareForIndex, C3a-1) uses. Never a second definition.
 *   category     the SERVER's C1 category (categoryOf). A client may ask only for a C1 key; anything else is
 *                refused (UNKNOWN_CATEGORY), never widened to "all".
 *   projection   a WHITELIST (publicCard). No phone, email, WhatsApp, licence, owner or internal field. A rating only
 *                when the reputation authority derived it (repV). `featured` is NOT carried: it is owner-writable
 *                on providers/{uid} and placement is C7 (Spotlight via AdminOS), not a self-declared flag.
 *
 * Ops (provider-dispatch — no new Cloud Function):
 *   providerDirectory { category?, limit? }  → { category, providers: [card], categories: [{id,label}], truncated }
 *   providerDirectory { providerId }         → { provider: card | null }      (one public card, or null)
 * Public and unauthenticated (App Check enforced by the dispatcher), like every directory.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const BCAT = require('./business-category');

const _db = () => admin.firestore();
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SCAN = 300;              /* per query; production holds 11 providers — pagination is flagged, not needed yet */
const MAX_LIMIT = 200;
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);
const _num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/** The public projection — a WHITELIST, built from the provider doc and its server eligibility. */
function publicCard(uid, p, category) {
  const hasRep = p.repV != null && Number(p.reviewCount) > 0 && Number.isFinite(Number(p.rating)) && Number(p.rating) > 0;
  const words = _san(p.category || p.serviceType, 80) || null;       /* the provider's own words — never a facet */
  const photo = String(p.photo || p.photoURL || p.image || '');
  return {
    uid,
    providerId: ID_RE.test(String(p.providerId || '')) ? String(p.providerId) : uid,
    name: _san(p.businessName || p.name || p.fullName || p.displayName, 160),
    businessName: _san(p.businessName, 160),
    category,
    categoryLabel: BCAT.label(category),
    displayCategory: words,
    serviceType: _san(p.serviceType, 80),
    description: _san(p.description || p.bio, 600),
    location: _san(p.location || p.city, 120),
    city: _san(p.city, 100),
    skills: (Array.isArray(p.skills) ? p.skills : []).slice(0, 20).map((s) => _san(s, 60)).filter(Boolean),
    rate: _num(p.rate),
    rateType: _san(p.rateType, 30),
    photo: /^https:\/\//i.test(photo) ? photo.slice(0, 500) : '',
    verified: p.verified === true,                                     /* admin-only on providers/{uid} */
    available: p.available !== false && p.isAvailable !== false,
    acceptsBookings: p.acceptsBookings !== false,
    chatEnabled: p.chatEnabled !== false,
    rating: hasRep ? Math.round(Number(p.rating) * 10) / 10 : null,
    reviewCount: hasRep ? Number(p.reviewCount) : 0,
    followerCount: p.followV != null && Number.isFinite(Number(p.followerCount)) ? Number(p.followerCount) : null,
    jobsCompleted: _num(p.jobsCompleted) || 0,                         /* server-derived; owner writes are refused */
    profilePending: (Array.isArray(p.profilePending) ? p.profilePending : []).slice(0, 20).map((s) => _san(s, 40)).filter(Boolean),
  };
}
const PUBLIC_FIELDS = Object.freeze(Object.keys(publicCard('x', {}, 'trades')));

/** One eligible provider → its card, or null. */
function cardIfEligible(uid, p) {
  if (!p) return null;
  const elig = BCAT.publicEligibility(p);
  return elig.eligible ? publicCard(uid, p, elig.category) : null;
}

/**
 * The providers that may hold `category` (or any category). The QUERY only narrows the read; the verdict is always
 * publicEligibility on the full document, so a query can never make a provider eligible.
 */
async function _candidates(db, category) {
  const col = db.collection('providers');
  if (!category) return [(await col.where('status', 'in', ['active', 'approved']).limit(SCAN).get())];
  const qs = [col.where('business.category', '==', category).limit(SCAN)];
  /* integrated authorities that predate C1 (categoryOf reads them): healthcare's own category, the Legal authority */
  if (BCAT.HEALTHCARE.includes(category)) qs.push(col.where('healthcare.category', '==', category).limit(SCAN));
  if (category === 'lawyer') qs.push(col.where('provisionedBy', '==', 'legal-verification').limit(SCAN));
  return Promise.all(qs.map((q) => q.get()));
}

async function listDirectory(db, { category, limit } = {}) {
  const cat = category == null ? '' : String(category);
  if (cat && !BCAT.isCategory(cat)) {
    throw new HttpsError('invalid-argument', 'Unknown category.', { code: 'UNKNOWN_CATEGORY' });
  }
  const lim = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit, 10) || 60));
  const snaps = await _candidates(db, cat);
  const seen = new Set(); const rows = [];
  let truncated = false;
  for (const s of snaps) {
    if (s.size >= SCAN) truncated = true;
    s.docs.forEach((d) => {
      if (seen.has(d.id)) return; seen.add(d.id);
      const c = cardIfEligible(d.id, d.data());
      if (c && (!cat || c.category === cat)) rows.push(c);
    });
  }
  rows.sort((a, b) => (Number(b.verified) - Number(a.verified)) || ((b.rating || 0) - (a.rating || 0)) || a.name.localeCompare(b.name));
  return { providers: rows.slice(0, lim), truncated: truncated || rows.length > lim };
}

async function getCard(db, providerId) {
  const id = String(providerId == null ? '' : providerId);
  if (!ID_RE.test(id)) throw new HttpsError('invalid-argument', 'A valid providerId is required.');
  const snap = await db.collection('providers').doc(id).get();
  return snap.exists ? cardIfEligible(snap.id, snap.data()) : null;
}

const _h = {};
_h.providerDirectory = async (req) => {
  const d = req.data || {};
  if (d.providerId != null) return { provider: await getCard(_db(), d.providerId) };
  const category = d.category == null || d.category === 'all' ? '' : String(d.category);
  const r = await listDirectory(_db(), { category, limit: d.limit });
  return { category: category || null, providers: r.providers, truncated: r.truncated,
    categories: BCAT.KEYS.map((c) => ({ id: c, label: BCAT.label(c) })) };
};

module.exports = { _h, listDirectory, getCard, cardIfEligible, publicCard, PUBLIC_FIELDS };
