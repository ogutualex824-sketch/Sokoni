/**
 * kass-directory.js — how Kass finds an APPROVED business: through the ONE canonical provider directory.
 *
 * WHY (census 2026-09-28): no public Kass tool could find a business approved through AdminOS, however long you waited.
 * search_marketplace read the legacy `services` registry, search_stays read `hotels` / `listings`, and
 * search_restaurants read raw `providers` with no eligibility gate at all (it could return suspended or unclassified
 * providers). Owner requirement: "any approved business must be known by Kass", immediately.
 *
 * WHAT THIS IS — a thin adapter, not a second authority:
 *   · the category a user names ("dj", "plumber", "hotel", "lawyer", "doctor") is resolved to a C1 key with the
 *     EXISTING C1 tables (business-category FROM_BUSINESS_ID / FROM_PROFESSION / labels) and healthcare-category —
 *     no new vocabulary is invented here;
 *   · results come from provider-directory.listDirectory, which reads Firestore LIVE and decides every row with
 *     business-category.publicEligibility — the same gate site search and the directory use. A business approved a
 *     minute ago is returned; a suspended, unapproved or unclassified one never is.
 * Pure resolution + one read; no writes.
 */
'use strict';
const BCAT = require('./business-category');
const HCAT = require('./healthcare-category');

const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const _slug = (v) => _norm(v).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* The C1 label words (e.g. "Hotel / BnB" → "hotel", "bnb"); built from the authority's own labels. */
const _LABEL_WORDS = (() => {
  const m = new Map();
  for (const k of BCAT.KEYS) {
    const words = String(BCAT.CATEGORIES[k].label || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
    for (const w of words) { if (!m.has(w)) m.set(w, new Set()); m.get(w).add(k); }
  }
  return m;
})();

/**
 * The C1 categories a user's words name — [] when nothing matches (the caller then says so honestly).
 * Order of evidence: an exact C1 key; an exact registrable business id or profession (C1's own tables, singular or
 * plural); a healthcare id; then a word of a C1 label. Never guesses beyond the authority's vocabulary.
 */
function resolveCategories(term) {
  const n = _norm(term); const s = _slug(term);
  if (!n) return [];
  if (BCAT.isCategory(n)) return [n];
  if (BCAT.isCategory(s.replace(/-/g, '_'))) return [s.replace(/-/g, '_')];
  const out = new Set();
  const tryWord = (w) => {
    if (!w) return;
    const byId = BCAT.FROM_BUSINESS_ID[w];
    if (byId) out.add(byId);
    const byProf = BCAT.FROM_PROFESSION[w.replace(/-/g, ' ')];
    if (byProf) out.add(byProf);
    const hc = HCAT.FROM_BUSINESS_ID && HCAT.FROM_BUSINESS_ID[w];
    if (hc && BCAT.isCategory(hc)) out.add(hc);
  };
  tryWord(s); if (s.endsWith('s')) tryWord(s.slice(0, -1));           /* "plumbers" → "plumber" */
  if (!out.size) {
    /* per word: exact ids/professions accept 2-letter words ("dj", "mc"); the looser label-word match needs ≥ 3 */
    for (const w of n.split(/[^a-z]+/).filter((x) => x.length >= 2)) {
      const stems = [w, w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : null].filter(Boolean);
      for (const st of stems) {
        tryWord(st);
        const hit = st.length >= 3 ? _LABEL_WORDS.get(st) : null;
        if (hit) hit.forEach((k) => out.add(k));
      }
    }
  }
  return [...out].filter((k) => BCAT.isCategory(k));
}

/**
 * Approved, publicly eligible businesses for a user's request. `location` narrows by the card's own city/location
 * text. Returns { categories, businesses[] } — cards are provider-directory's public whitelist (no phone, no email).
 */
async function findBusinesses(db, { category, query, location, limit } = {}) {
  const PD = require('./provider-directory');
  const cats = resolveCategories(category || query || '');
  const lim = Math.max(1, Math.min(12, parseInt(limit, 10) || 8));
  const loc = _norm(location);
  const rows = [];
  const seen = new Set();
  for (const c of (cats.length ? cats : [])) {
    const r = await PD.listDirectory(db, { category: c, limit: 60 });
    for (const p of r.providers || []) {
      if (seen.has(p.uid)) continue;
      if (loc && !(_norm(p.city).includes(loc) || _norm(p.location).includes(loc))) continue;
      seen.add(p.uid); rows.push(p);
    }
  }
  return { categories: cats, businesses: rows.slice(0, lim) };
}

module.exports = { resolveCategories, findBusinesses };
