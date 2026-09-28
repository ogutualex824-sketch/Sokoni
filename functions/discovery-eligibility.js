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

module.exports = { prepareForIndex, ownerOf, PROVIDER_SCOPED, DEINDEXED };
