/**
 * SOKONI Algolia Recommend API
 *
 * Exposes all five Algolia Recommend models via Firebase Callable Functions:
 *   getAlgoliaFBT            — Frequently Bought Together
 *   getAlgoliaRelated        — Related Products
 *   getAlgoliaTrendingItems  — Trending Items per index
 *   getAlgoliaTrendingFacets — Trending Facet values
 *   getAlgoliaLookingSimilar — Visually similar items
 *
 * Event recording:
 *   algoliaRecommendEvent — record click/cart/purchase from a Recommend widget
 *
 * Maintenance:
 *   algoliaRecommendRefresh — admin callable to check model status
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

const { AlgoliaClient }      = require('./algolia-indexer');

const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _client() {
  const appId = process.env.ALGOLIA_APP_ID;
  const key   = ALGOLIA_ADMIN_KEY.value();
  if (!appId || !key || key === 'not_configured') return null;
  return new AlgoliaClient(appId, key);
}

/* ── Shared validation ────────────────────────────────────────────────── */

function _assertConfigured(algolia) {
  if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');
}

/* ── Recommend helper ─────────────────────────────────────────────────── */

async function _recommend(requests) {
  const algolia = _client();
  _assertConfigured(algolia);
  try {
    const result = await algolia.getRecommendations(requests);
    return { ok: true, results: result.results };
  } catch (err) {
    console.error('[AlgoliaRecommend] Request failed:', err.message);
    throw new HttpsError('internal', `Algolia Recommend error: ${err.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaFBT — Frequently Bought Together
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaFBT = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10, cors: true },
  async (request) => {
    const {
      objectID,
      indexName      = 'sokoni_products',
      maxRecommendations = 6,
      threshold      = 0,
      queryParameters,
      fallbackParameters,
    } = request.data || {};

    if (!objectID) throw new HttpsError('invalid-argument', 'objectID is required.');

    return _recommend([{
      model:              'bought-together',
      indexName,
      objectID,
      threshold,
      maxRecommendations,
      queryParameters:    queryParameters    || { analytics: true },
      fallbackParameters: fallbackParameters || { hitsPerPage: maxRecommendations },
    }]);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaRelated — Related Products
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaRelated = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10, cors: true },
  async (request) => {
    const {
      objectID,
      indexName      = 'sokoni_products',
      maxRecommendations = 8,
      threshold      = 0,
      queryParameters,
      fallbackParameters,
    } = request.data || {};

    if (!objectID) throw new HttpsError('invalid-argument', 'objectID is required.');

    return _recommend([{
      model:              'related-products',
      indexName,
      objectID,
      threshold,
      maxRecommendations,
      queryParameters:    queryParameters    || { analytics: true },
      fallbackParameters: fallbackParameters || {
        hitsPerPage: maxRecommendations,
        filters:     'status:active OR status:published',
      },
    }]);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaTrendingItems — Trending Items for an index
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaTrendingItems = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10, cors: true },
  async (request) => {
    const {
      indexName      = 'sokoni_products',
      facetName,
      facetValue,
      maxRecommendations = 12,
      threshold      = 0,
      queryParameters,
    } = request.data || {};

    const req = {
      model:              'trending-items',
      indexName,
      threshold,
      maxRecommendations,
      queryParameters:    queryParameters || { analytics: true, hitsPerPage: maxRecommendations },
    };

    /* Optional facet context — e.g. trending phones, trending shoes */
    if (facetName && facetValue) {
      req.facetName  = facetName;
      req.facetValue = facetValue;
    }

    return _recommend([req]);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaTrendingFacets — Trending Facet Values for an attribute
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaTrendingFacets = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10, cors: true },
  async (request) => {
    const {
      indexName  = 'sokoni_products',
      facetName  = 'category',
      threshold  = 0,
      maxRecommendations = 10,
    } = request.data || {};

    if (!facetName) throw new HttpsError('invalid-argument', 'facetName is required.');

    return _recommend([{
      model:              'trending-facets',
      indexName,
      facetName,
      threshold,
      maxRecommendations,
    }]);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaLookingSimilar — Visually similar items
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaLookingSimilar = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10, cors: true },
  async (request) => {
    const {
      objectID,
      indexName      = 'sokoni_products',
      maxRecommendations = 6,
      threshold      = 0,
      queryParameters,
      fallbackParameters,
    } = request.data || {};

    if (!objectID) throw new HttpsError('invalid-argument', 'objectID is required.');

    return _recommend([{
      model:              'looking-similar',
      indexName,
      objectID,
      threshold,
      maxRecommendations,
      queryParameters:    queryParameters    || { analytics: true },
      fallbackParameters: fallbackParameters || {
        hitsPerPage: maxRecommendations,
        filters:     'status:active OR status:published',
      },
    }]);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaMultiRecommend — Batch multiple recommend models at once
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaMultiRecommend = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15, cors: true },
  async (request) => {
    const { requests } = request.data || {};
    if (!Array.isArray(requests) || !requests.length) {
      throw new HttpsError('invalid-argument', 'requests array is required.');
    }
    if (requests.length > 20) {
      throw new HttpsError('invalid-argument', 'Maximum 20 requests per batch.');
    }

    const VALID_MODELS = ['bought-together', 'related-products', 'trending-items', 'trending-facets', 'looking-similar'];
    for (const r of requests) {
      if (!VALID_MODELS.includes(r.model)) {
        throw new HttpsError('invalid-argument', `Invalid model: ${r.model}`);
      }
    }

    return _recommend(requests);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaRecommendEvent — record user interaction from a Recommend widget
══════════════════════════════════════════════════════════════════════ */

const algoliaRecommendEvent = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10, cors: true },
  async (request) => {
    const {
      type,           // 'click' | 'add_to_cart' | 'purchase'
      objectIDs,
      indexName = 'sokoni_products',
      currency  = 'KES',
      value,
      objectData,
    } = request.data || {};

    const VALID = ['click', 'add_to_cart', 'purchase'];
    if (!VALID.includes(type)) throw new HttpsError('invalid-argument', 'type must be click, add_to_cart, or purchase.');
    if (!Array.isArray(objectIDs) || !objectIDs.length) throw new HttpsError('invalid-argument', 'objectIDs required.');

    const uid       = request.auth?.uid || null;
    const userToken = uid || `anon_${request.rawRequest?.ip?.replace(/[.:]/g, '_') || 'x'}`;
    const algolia   = _client();
    _assertConfigured(algolia);

    const tsNow = Date.now();

    const EVENT_MAP = {
      click:       { eventType: 'click',      eventName: 'Recommend Product Clicked' },
      add_to_cart: { eventType: 'conversion', eventName: 'Recommend Product Added To Cart', eventSubtype: 'addToCart' },
      purchase:    { eventType: 'conversion', eventName: 'Recommend Product Purchased',      eventSubtype: 'purchase'  },
    };

    const ev = {
      ...EVENT_MAP[type],
      index:     indexName,
      userToken,
      objectIDs,
      currency,
      timestamp: tsNow,
    };
    if (value !== undefined) ev.value = value;
    if (objectData)          ev.objectData = objectData;

    /* Fire Algolia Insights event */
    await algolia.sendEvents([ev]).catch(err => {
      console.warn('[AlgoliaRecommend] Event forward failed:', err.message);
    });

    /* Log to Firestore for local analytics */
    await _db().collection('algoliaRecommendEvents').add({
      type, objectIDs, indexName, currency, value: value || null,
      userToken, uid, ts: _now(),
    });

    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaRecommendStatus — admin: view model training status
══════════════════════════════════════════════════════════════════════ */

const algoliaRecommendStatus = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    if (!request.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only.');
    const algolia = _client();
    _assertConfigured(algolia);

    /* Algolia Recommend status is checked via a search for events coverage */
    const PRIMARY_MODELS = [
      { indexName: 'sokoni_products', model: 'related-products'  },
      { indexName: 'sokoni_products', model: 'bought-together'   },
      { indexName: 'sokoni_products', model: 'trending-items'    },
      { indexName: 'sokoni_products', model: 'looking-similar'   },
      { indexName: 'sokoni_services', model: 'related-products'  },
      { indexName: 'sokoni_services', model: 'trending-items'    },
      { indexName: 'sokoni_events',   model: 'trending-items'    },
      { indexName: 'sokoni_jobs',     model: 'trending-items'    },
    ];

    /* Test each model by requesting 1 recommendation from a sentinel objectID */
    const status = await Promise.allSettled(
      PRIMARY_MODELS.map(async ({ indexName, model }) => {
        await algolia.getRecommendations([{
          model, indexName,
          objectID: model !== 'trending-items' ? '_test_probe_' : undefined,
          maxRecommendations: 1, threshold: 0,
        }]);
        return { indexName, model, status: 'ok' };
      })
    );

    return {
      ok: true,
      models: PRIMARY_MODELS.map((m, i) => ({
        ...m,
        ok:    status[i].status === 'fulfilled',
        error: status[i].status === 'rejected' ? status[i].reason?.message : null,
      })),
      checkedAt: new Date().toISOString(),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaRecommendAnalyticsCleanup — purge recommend events older than 90 days
══════════════════════════════════════════════════════════════════════ */

const algoliaRecommendAnalyticsCleanup = onSchedule(
  { schedule: 'every sunday 04:30', timeoutSeconds: 120 },
  async () => {
    const db     = _db();
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 90 * 86_400_000);
    const snap   = await db.collection('algoliaRecommendEvents')
      .where('ts', '<', cutoff)
      .limit(2000)
      .get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`[AlgoliaRecommend] Purged ${snap.size} old recommend events`);
  }
);

module.exports = {
  getAlgoliaFBT,
  getAlgoliaRelated,
  getAlgoliaTrendingItems,
  getAlgoliaTrendingFacets,
  getAlgoliaLookingSimilar,
  getAlgoliaMultiRecommend,
  algoliaRecommendEvent,
  algoliaRecommendStatus,
  algoliaRecommendAnalyticsCleanup,
};
