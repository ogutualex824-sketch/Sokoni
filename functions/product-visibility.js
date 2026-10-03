/* ════════════════════════════════════════════════════════════════════════
   product-visibility.js — THE canonical public-visibility gate for a product (takedown enforcement, 2026-10-02)

   Pure decision logic + one bounded batch reader. No second moderation authority and no new collection: the
   decision reads ONLY the canonical product document (`products/{id}`) that every writer already maintains —
     isVisible === false           → hidden (moderation take-down via tsReviewReport, or the seller's own switch-off)
     moderationHold present         → held by moderation (fail closed even if isVisible were ever re-set by a stray writer)
     status in HIDDEN_STATUSES      → not public (the vocabulary /api/catalogue already used, plus the indexers' skip set)
     visible === false / deleted    → legacy hidden flags
   Every public server surface (API by id, gateway routes, search hit → response, recommendations, shop page,
   trending, KASS tools, click-and-collect) asks THIS module, so a stale search index or projection can never turn a
   taken-down listing back into a public product response (spec §10).

   The public vocabulary (spec §6, §11): a non-public product is reported as UNAVAILABLE to the public — the same
   answer whether it is taken down, switched off, archived or missing, so the response never says "this seller was
   reported for X" and never confirms that a moderation case exists.
   ════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ONE LISTING AUTHORITY. The canonical "is this product publicly listed" predicate is SokoniSellability
   (shared/sellability.js on the serving functions lineage, sokoni-sellability.js on hosting). Where that module is
   present it IS the decision; this file only adds the moderation hold in front of it. This functions tree predates
   shared/sellability.js (the 09-09 serving archives carry it), so the fallback below is a byte-for-byte copy of its
   HIDDEN_STATUSES plus the indexers' 'spam' — never a second, divergent list. */
let _sellability = null;
try { _sellability = require('./shared/sellability'); } catch (_) { _sellability = null; }
const HIDDEN_STATUSES = Object.freeze(['deleted', 'removed', 'hidden', 'draft', 'archived', 'banned', 'suspended',
  'paused', 'inactive', 'rejected', 'unpublished', 'spam']);
const _HIDDEN = new Set(HIDDEN_STATUSES);

/* Fields that are moderation/enforcement metadata. They never appear in a public DTO (spec §12). */
const MODERATION_FIELDS = Object.freeze(['moderationHold', 'moderationReleased', 'previousIsVisible']);

/* Index-layer filters that express the same rule for the engines that index the fields. Typesense's sokoni_products
   schema and Algolia's transformer do not index `isVisible`, so for those engines the guarantee is the indexers'
   removal of hidden docs (typesense-sync.js / algolia-sync.js) PLUS the server re-check below — never the filter alone. */
const TYPESENSE_STATUS_FILTER = 'status:!=[' + HIDDEN_STATUSES.join(',') + ']';

/** The decision. Returns { visible, reason } — reason is internal (logs/tests), never sent to the public. */
function publicVisibility(p) {
  if (!p || typeof p !== 'object') return { visible: false, reason: 'missing' };
  if (p.moderationHold != null) return { visible: false, reason: 'moderation_hold' };
  if (_sellability && typeof _sellability.isPubliclyListed === 'function') {
    if (!_sellability.isPubliclyListed(p)) return { visible: false, reason: 'not_listed' };
    if (String(p.status || '').toLowerCase() === 'spam') return { visible: false, reason: 'status_spam' };
    return { visible: true, reason: null };
  }
  if (p.isVisible === false) return { visible: false, reason: 'hidden' };
  if (p.visible === false) return { visible: false, reason: 'hidden_legacy' };
  if (p.isDeleted === true || p.deleted === true) return { visible: false, reason: 'deleted' };
  const st = String(p.status || '').toLowerCase();
  if (_HIDDEN.has(st)) return { visible: false, reason: 'status_' + st };
  return { visible: true, reason: null };
}
function isPubliclyVisible(p) { return publicVisibility(p).visible; }

/** A public DTO never carries moderation/enforcement metadata. Returns a shallow copy. */
function stripModeration(p) {
  if (!p || typeof p !== 'object') return p;
  const o = Object.assign({}, p);
  for (const k of MODERATION_FIELDS) delete o[k];
  return o;
}

/* The public answer for a product that is not public. One shape for every non-public reason (spec §6). */
const UNAVAILABLE = Object.freeze({ available: false, state: 'UNAVAILABLE' });

/**
 * Re-check a list of product ids against the CANONICAL documents (the stale-index guard, spec §10).
 * Bounded: at most `max` ids (default 100), read with getAll in chunks of 50 — no scans, no listeners.
 * Returns { visible: Map id → data, hidden: Set, missing: Set }. A read that throws propagates (the caller fails
 * closed); it is never treated as "visible".
 */
async function classifyProductIds(db, ids, opts) {
  const max = (opts && opts.max) || 100;
  const uniq = [...new Set((ids || []).map((x) => String(x == null ? '' : x)).filter((x) => x && x.length <= 300 && !x.includes('/')))].slice(0, max);
  const out = { visible: new Map(), hidden: new Set(), missing: new Set() };
  if (!uniq.length) return out;
  const col = db.collection('products');
  for (let i = 0; i < uniq.length; i += 50) {
    const refs = uniq.slice(i, i + 50).map((id) => col.doc(id));
    const snaps = typeof db.getAll === 'function' ? await db.getAll(...refs) : await Promise.all(refs.map((r) => r.get()));
    snaps.forEach((s, j) => {
      const id = s && s.id ? s.id : uniq[i + j];
      if (!s || !s.exists) { out.missing.add(id); return; }
      const d = s.data() || {};
      if (isPubliclyVisible(d)) out.visible.set(id, d); else out.hidden.add(id);
    });
  }
  return out;
}
async function visibleProductsById(db, ids, opts) {
  return (await classifyProductIds(db, ids, opts)).visible;
}

/**
 * Filter search hits (or any id-bearing rows) down to those that may be shown publicly NOW.
 * A hit whose `products/{id}` document exists and is not public (taken down, hidden, archived …) is ALWAYS dropped.
 * A hit with NO products document is kept only when `dropMissing` is false (the default for shared search indexes,
 * where sokoni_products also carries foods / deals / inventory_products records under their own ids); a product-only
 * surface (API by id, cart, compare) passes dropMissing:true.
 * `idOf(hit)` extracts the id (default: hit.id || hit.objectID || hit.document?.id). Order is preserved.
 * Rows for which `isProduct(hit)` is false (other collections in a multi-index response) are passed through.
 * Returns { hits, removed }.
 */
async function filterVisibleHits(db, hits, opts) {
  const o = opts || {};
  const idOf = o.idOf || ((h) => (h && (h.id || h.objectID || (h.document && h.document.id))) || null);
  const isProduct = o.isProduct || (() => true);
  const list = Array.isArray(hits) ? hits : [];
  const ids = list.filter(isProduct).map(idOf).filter(Boolean);
  const c = await classifyProductIds(db, ids, { max: Math.max(o.max || 0, ids.length, 1) });
  const keep = list.filter((h) => {
    if (!isProduct(h)) return true;
    const id = idOf(h);
    if (!id) return false;
    if (c.visible.has(String(id))) return true;
    if (c.hidden.has(String(id))) return false;
    return !o.dropMissing;
  }).map((h) => (h && typeof h === 'object' ? stripModeration(h) : h));
  return { hits: keep, removed: list.length - keep.length };
}

module.exports = {
  HIDDEN_STATUSES, MODERATION_FIELDS, TYPESENSE_STATUS_FILTER, UNAVAILABLE,
  publicVisibility, isPubliclyVisible, stripModeration, classifyProductIds, visibleProductsById, filterVisibleHits,
};
