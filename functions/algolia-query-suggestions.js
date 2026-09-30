/**
 * SOKONI Algolia Query Suggestions
 *
 * Manages dedicated Query Suggestions indexes that power the autocomplete
 * dropdowns across all SOKONI search experiences.
 *
 * Model:
 *   Source index (e.g. sokoni_products) → Algolia trains → sokoni_products_suggestions
 *
 * Each suggestions index contains:
 *   - Query string
 *   - nb_words, popularity, external_popularity
 *   - Facet counts for promoted facet values
 *
 * Cloud Functions:
 *   algoliaSetupQuerySuggestions  — create/update all QS configurations (admin)
 *   algoliaGetQuerySuggestions    — public: get autocomplete for a prefix
 *   algoliaQSRebuildStatus        — admin: check status of suggestion index builds
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

const { AlgoliaClient }      = require('./algolia-indexer');

const ALGOLIA_ADMIN_KEY  = defineSecret('ALGOLIA_ADMIN_KEY');
const ALGOLIA_REGION     = process.env.ALGOLIA_QS_REGION || 'us';

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _client() {
  const appId = process.env.ALGOLIA_APP_ID;
  const key   = ALGOLIA_ADMIN_KEY.value();
  if (!appId || !key || key === 'not_configured') return null;
  return new AlgoliaClient(appId, key);
}

function _assertAdmin(request) {
  if (!request.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only.');
}

/* ── Query Suggestions Configurations ────────────────────────────────── */

const QS_CONFIGS = [
  {
    indexName:    'sokoni_products_suggestions',
    sourceIndices: [{
      indexName:           'sokoni_products',
      minHits:             5,
      minLetters:          4,
      generate:            [['category'], ['brand'], ['category', 'brand']],
      external:            [],
      analyticsTags:       ['query-suggestions'],
    }],
    languages:     ['en'],
    exclude:       [],
    enablePersonalization: false,
  },
  {
    indexName:    'sokoni_services_suggestions',
    sourceIndices: [{
      indexName:           'sokoni_services',
      minHits:             3,
      minLetters:          3,
      generate:            [['category'], ['location.city']],
      analyticsTags:       ['query-suggestions'],
    }],
    languages:     ['en'],
    exclude:       [],
  },
  {
    indexName:    'sokoni_events_suggestions',
    sourceIndices: [{
      indexName:           'sokoni_events',
      minHits:             2,
      minLetters:          3,
      generate:            [['category'], ['location.city']],
      analyticsTags:       ['query-suggestions'],
    }],
    languages:     ['en'],
    exclude:       [],
  },
  {
    indexName:    'sokoni_jobs_suggestions',
    sourceIndices: [{
      indexName:           'sokoni_jobs',
      minHits:             3,
      minLetters:          3,
      generate:            [['category'], ['jobType']],
      analyticsTags:       ['query-suggestions'],
    }],
    languages:     ['en'],
    exclude:       [],
  },
  {
    indexName:    'sokoni_properties_suggestions',
    sourceIndices: [{
      indexName:           'sokoni_properties',
      minHits:             2,
      minLetters:          3,
      generate:            [['type'], ['location.city'], ['location.area']],
      analyticsTags:       ['query-suggestions'],
    }],
    languages:     ['en'],
    exclude:       [],
  },
  {
    indexName:    'sokoni_vehicles_suggestions',
    sourceIndices: [{
      indexName:           'sokoni_vehicles',
      minHits:             2,
      minLetters:          3,
      generate:            [['make'], ['bodyType'], ['fuelType']],
      analyticsTags:       ['query-suggestions'],
    }],
    languages:     ['en'],
    exclude:       [],
  },
];

/* ══════════════════════════════════════════════════════════════════════
   algoliaSetupQuerySuggestions  — create/update all QS configurations
══════════════════════════════════════════════════════════════════════ */

const algoliaSetupQuerySuggestions = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 120 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const results = {};

    for (const config of QS_CONFIGS) {
      try {
        /* Try to update existing config first; create if not found */
        try {
          await algolia.updateQuerySuggestionsConfig(config.indexName, config, ALGOLIA_REGION);
          results[config.indexName] = { ok: true, action: 'updated' };
        } catch (updateErr) {
          if (updateErr.status === 404) {
            await algolia.createQuerySuggestionsConfig(config, ALGOLIA_REGION);
            results[config.indexName] = { ok: true, action: 'created' };
          } else {
            throw updateErr;
          }
        }
        console.log(`[AlgoliaQS] Configured ${config.indexName}`);
      } catch (err) {
        results[config.indexName] = { ok: false, error: err.message };
        console.error(`[AlgoliaQS] Failed for ${config.indexName}:`, err.message);
      }
    }

    await _db().collection('adminAuditLogs').add({
      action: 'algolia_setup_query_suggestions',
      by:     request.auth.uid,
      results,
      createdAt: _now(),
    });

    return { ok: true, results, count: QS_CONFIGS.length };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaGetQuerySuggestions  — public autocomplete endpoint
══════════════════════════════════════════════════════════════════════ */

const algoliaGetQuerySuggestions = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 5, cors: true },
  async (request) => {
    const {
      query       = '',
      indexName   = 'sokoni_products_suggestions',
      hitsPerPage = 8,
      hub,
    } = request.data || {};

    if (!query || query.length < 1) return { hits: [] };

    const algolia = _client();
    if (!algolia) return { hits: [] };

    /* Build filters for hub-scoped suggestions */
    const params = {
      query,
      hitsPerPage: Math.min(hitsPerPage, 20),
      analytics:   false, // QS searches don't pollute main analytics
    };
    if (hub) params.filters = `hub:${hub}`;

    try {
      const result = await algolia._request('POST', `/1/indexes/${encodeURIComponent(indexName)}/query`, params);
      return { hits: result.hits || [] };
    } catch (err) {
      console.warn('[AlgoliaQS] Suggestion fetch failed:', err.message);
      return { hits: [] };
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaQSRebuildStatus  — admin: check all QS index statuses
══════════════════════════════════════════════════════════════════════ */

const algoliaQSRebuildStatus = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 30 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const statuses = await Promise.allSettled(
      QS_CONFIGS.map(async config => {
        const stats = await algolia.getIndexStats(config.indexName);
        return {
          indexName: config.indexName,
          entries:   stats.entries || 0,
          updatedAt: stats.updatedAt || null,
        };
      })
    );

    return {
      ok: true,
      indexes: QS_CONFIGS.map((c, i) => ({
        indexName: c.indexName,
        ...(statuses[i].status === 'fulfilled' ? statuses[i].value : { error: statuses[i].reason?.message }),
      })),
      checkedAt: new Date().toISOString(),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaQSSettings — ensure suggestion indexes have correct settings
══════════════════════════════════════════════════════════════════════ */

const QS_INDEX_SETTINGS = {
  searchableAttributes:         ['query'],
  attributesForFaceting:        ['filterOnly(query)'],
  hitsPerPage:                  8,
  maxFacetHits:                 10,
  typoTolerance:                'min',
  minWordSizefor1Typo:          4,
  minWordSizefor2Typos:         8,
  highlightPreTag:              '<em>',
  highlightPostTag:             '</em>',
  distinct:                     true,
  attributeForDistinct:         'query',
};

const algoliaSetupQSIndexSettings = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 60 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const results = {};
    for (const config of QS_CONFIGS) {
      try {
        await algolia.setIndexSettings(config.indexName, QS_INDEX_SETTINGS);
        results[config.indexName] = { ok: true };
      } catch (err) {
        results[config.indexName] = { ok: false, error: err.message };
      }
    }

    return { ok: true, results };
  }
);

module.exports = {
  algoliaSetupQuerySuggestions,
  algoliaGetQuerySuggestions,
  algoliaQSRebuildStatus,
  algoliaSetupQSIndexSettings,
  QS_CONFIGS,
};
