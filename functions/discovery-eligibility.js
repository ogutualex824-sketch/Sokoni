'use strict';
/**
 * SOKONI — the ONE public-discovery predicate  (CHANGELOG 243, convergence C3a)
 * ============================================================================================
 * What may appear in PUBLIC search, and under WHICH category. Every path that writes a search index calls this:
 * the Algolia and Typesense queues (algolia-queue.enqueue / typesense-queue.enqueue — the choke point every trigger,
 * reconciler, repair job and backfill goes through) and the Typesense admin reindex (which bypasses the queue).
 *
 *   prepareForIndex(db, collection, docId, data) → null   (never index — and a queued upsert becomes a DELETE)
 *                                                 → data' (the document to index, with the SERVER's category)
 *
 * PROVIDER-SCOPED collections (providers, providerProfiles, providerServices) are discoverable only when the OWNING
 * provider is publicly eligible — functions/business-category.publicEligibility: approved/active, not suspended,
 * searchable, and CLASSIFIED by the server (C1). Their facet category is the C1 category (categoryOf), never the
 * provider-editable `category` / `categories` / `serviceType` / `subcategory` / `hub`. The provider's own wording is
 * kept only as `displayCategory`, which is not a facet. An UNCLASSIFIED provider — including one approved before C1 —
 * is not discoverable until AdminOS classifies it (owner decision 2026-09-28).
 *
 * LEGACY REGISTRIES outside C1's authority (owner decision 2026-09-28) are DE-INDEXED from public search:
 * mechanics, lawyers, healthProviders, homeServiceProviders, services. The collections themselves are untouched.
 *
 * Accommodation listings (bnbListings) are discoverable only when APPROVED ('active' — the approval gate, CHANGELOG
 * 242). Every other collection is returned unchanged: its own existing skip rules still apply, and shop / product
 * discovery is out of this slice (flagged).
 */
const BCAT = require('./business-category');

const PROVIDER_SCOPED = Object.freeze(['providers', 'providerProfiles', 'providerServices']);
const DEINDEXED = Object.freeze(['mechanics', 'lawyers', 'healthProviders', 'homeServiceProviders', 'services']);

/** The uid of the provider that owns a provider-scoped document. */
function ownerOf(collection, docId, data) {
  if (collection === 'providers' || collection === 'providerProfiles') return String(docId || '');
  if (collection === 'providerServices') return String((data && (data.providerId || data.uid)) || '');
  return '';
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} collection
 * @param {string} docId
 * @param {object} data       the document as it will be indexed
 * @param {object} [cache]    optional { [uid]: providerDoc|null } to share provider reads across a batch
 * @returns {Promise<object|null>}
 */
async function prepareForIndex(db, collection, docId, data, cache) {
  if (!data) return null;
  if (DEINDEXED.includes(collection)) return null;
  if (collection === 'bnbListings') return data.status === 'active' ? data : null;
  if (!PROVIDER_SCOPED.includes(collection)) return data;

  if (collection === 'providerServices' && (data.active === false || data.removedAt)) return null;
  const uid = ownerOf(collection, docId, data);
  if (!uid || /[/]/.test(uid)) return null;
  let prov;
  if (cache && Object.prototype.hasOwnProperty.call(cache, uid)) prov = cache[uid];
  else {
    const s = collection === 'providers' ? null : await db.collection('providers').doc(uid).get();
    prov = collection === 'providers' ? data : (s && s.exists ? s.data() : null);
    if (cache) cache[uid] = prov;
  }
  if (!prov) return null;
  const elig = BCAT.publicEligibility(prov);
  if (!elig.eligible) return null;
  return Object.assign({}, data, {
    category: elig.category,                       /* the SERVER's category — the only facet */
    categories: [elig.category],
    categoryLabel: BCAT.label(elig.category),
    serviceType: null,
    subcategory: null,
    hub: 'services',
    displayCategory: String(data.category || data.serviceType || '').slice(0, 80) || null,   /* the provider's words — not a facet */
  });
}

/* ── C3b-1 (CHANGELOG 245): an OWNER's public change reaches its dependents ──────────────────────────────────────
   A provider's profile and services are gated on the OWNER's eligibility and indexed under the OWNER's category, but
   they are re-evaluated only when a search trigger fires for THEM. Without this, suspending, hiding or reclassifying a
   provider re-indexed the provider document alone and left its profile and services in search, under the old category.

   The cascade adds NO second definition: it only re-queues the dependents as upserts, and the queue's own gate
   (prepareForIndex above) decides — eligible → indexed under the owner's current category, ineligible → DELETE. */

const _NONE = Object.freeze({ eligible: false, category: null });

/** Did the owner's PUBLIC state change — eligibility, or the C1 category while eligible? (null/absent = not public) */
function discoveryChanged(before, after) {
  const b = before ? BCAT.publicEligibility(before) : _NONE;
  const a = after ? BCAT.publicEligibility(after) : _NONE;
  if (b.eligible !== a.eligible) return true;
  return a.eligible && b.category !== a.category;      /* both hidden → nothing indexed either way */
}

const DEPENDENT_PAGE = 100;   /* per query page */
const DEPENDENT_MAX = 500;    /* per owner change — bounded; a truncation is reported, and the C3b-2 cleanup covers it */
const DEPENDENT_CONCURRENCY = 20;

/**
 * Re-queue an owner's profile and services through `enqueue` (the SAME gated enqueue of one engine's queue). Idempotent:
 * both queues key an entry by `${collection}_${docId}`, so a repeat overwrites rather than duplicates.
 * @returns {Promise<{profiles:number, services:number, truncated:boolean}>}
 */
async function requeueDependents(db, uid, enqueue, opts) {
  const o = Object.assign({ page: DEPENDENT_PAGE, max: DEPENDENT_MAX }, opts || {});
  const out = { profiles: 0, services: 0, truncated: false };
  uid = String(uid || '');
  if (!uid || /[/]/.test(uid)) return out;

  const prof = await db.collection('providerProfiles').doc(uid).get();
  if (prof.exists) { await enqueue({ collection: 'providerProfiles', docId: uid, operation: 'upsert', data: prof.data() }); out.profiles = 1; }

  /* ownerOf reads providerId || uid — page both, de-duplicated */
  const docId = require('firebase-admin').firestore.FieldPath.documentId();
  const seen = new Set();
  for (const field of ['providerId', 'uid']) {
    let last = null;
    for (;;) {
      let q = db.collection('providerServices').where(field, '==', uid).orderBy(docId).limit(o.page);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      const batch = [];
      for (const d of snap.docs) {
        if (seen.has(d.id)) continue;
        if (seen.size >= o.max) { out.truncated = true; break; }
        seen.add(d.id); batch.push(d);
      }
      for (let i = 0; i < batch.length; i += DEPENDENT_CONCURRENCY) {
        await Promise.all(batch.slice(i, i + DEPENDENT_CONCURRENCY).map((d) =>
          enqueue({ collection: 'providerServices', docId: d.id, operation: 'upsert', data: d.data() })));
      }
      out.services += batch.length;
      if (out.truncated || snap.size < o.page) break;
      last = snap.docs[snap.docs.length - 1];
    }
    if (out.truncated) break;
  }
  return out;
}

/**
 * The one cascade entry point both engines' `providers` triggers call AFTER enqueuing the provider itself.
 * Never throws: a cascade failure is logged and must not fail (or retry-storm) the provider's own sync.
 */
async function cascadeOwnerChange(db, uid, before, after, enqueue, engine) {
  if (!discoveryChanged(before, after)) return null;
  try {
    const r = await requeueDependents(db, uid, enqueue);
    const log = require('firebase-functions/logger');
    (r.truncated ? log.warn : log.info)('[discovery] owner change re-queued dependents', { engine, uid, ...r });
    return r;
  } catch (e) {
    try { require('firebase-functions/logger').error('[discovery] dependent re-queue failed', { engine, uid, error: e && e.message }); } catch (_) { /* logger unavailable */ }
    return { error: (e && e.message) || String(e) };
  }
}

module.exports = { prepareForIndex, ownerOf, PROVIDER_SCOPED, DEINDEXED,
  discoveryChanged, requeueDependents, cascadeOwnerChange, DEPENDENT_MAX };
