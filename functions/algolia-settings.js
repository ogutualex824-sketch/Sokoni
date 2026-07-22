/**
 * SOKONI Algolia Settings — Index configuration, synonyms, and query rules
 *
 * Applies settings to EXISTING Algolia indexes. Does NOT create or delete indexes.
 *
 * Exports (Firebase onCall functions):
 *   searchApplyIndexSettings  — Admin: apply per-index settings to all 8 indexes
 *   searchValidateIndexes     — Admin: verify all expected indexes exist, return stats
 *   searchApplySynonyms       — Admin: apply Kenyan marketplace synonyms to all indexes
 *   searchApplyRules          — Admin: apply query rules (boost verified, in-stock, featured)
 *
 * Also exports static config for testing and documentation:
 *   INDEX_SETTINGS, KENYAN_SYNONYMS
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');

const { AlgoliaClient } = require('./algolia-indexer');

/* ── Guards ─────────────────────────────────────────────────────────────── */

function _assertAdmin(req) {
  if (!req.auth?.token?.admin) {
    throw new HttpsError('permission-denied', 'Admin role required');
  }
  return req.auth.uid;
}

function _client() {
  const appId = process.env.ALGOLIA_APP_ID;
  const key   = ALGOLIA_ADMIN_KEY.value();
  if (!appId || !key) {
    throw new HttpsError('internal', 'Algolia credentials not configured');
  }
  return new AlgoliaClient(appId, key);
}

/* ═══════════════════════════════════════════════════════════════════════════
   INDEX SETTINGS
   Applied to all 8 existing indexes. Does NOT recreate indexes.
════════════════════════════════════════════════════════════════════════════ */

const INDEX_SETTINGS = {

  sokoni_products: {
    searchableAttributes: [
      'unordered(name)',
      'unordered(brand)',
      'unordered(description)',
      'unordered(category,subcategory)',
      'tags,keywords',
      'seller.name',
      'unordered(location.city,location.county)',
    ],
    attributesForFaceting: [
      'searchable(category)',
      'searchable(subcategory)',
      'filterOnly(brand)',
      'filterOnly(price)',
      'searchable(location.city)',
      'searchable(location.county)',
      'filterOnly(rating)',
      'filterOnly(inStock)',
      'filterOnly(condition)',
      'filterOnly(seller.verified)',
      'filterOnly(isFeatured)',
      'filterOnly(hub)',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(seller.verified)',
      'desc(_popularityScore)',
      'desc(_salesScore)',
      'desc(rating)',
      'asc(inStock)',
    ],
    ranking: ['typo','geo','words','filters','proximity','attribute','exact','custom'],
    typoTolerance: true,
    minWordSizefor1Typo: 3,
    minWordSizefor2Typos: 7,
    advancedSyntax: true,
    enablePersonalization: true,
    maxValuesPerFacet: 100,
    hitsPerPage: 24,
    attributesToRetrieve: ['*'],
    attributesToHighlight: ['name','description','brand','category'],
    highlightPreTag:  '<mark>',
    highlightPostTag: '</mark>',
  },

  sokoni_shops: {
    searchableAttributes: [
      'unordered(name)',
      'unordered(description)',
      'unordered(category)',
      'unordered(location.city,location.county)',
      'tags',
    ],
    attributesForFaceting: [
      'searchable(category)',
      'searchable(location.city)',
      'searchable(location.county)',
      'filterOnly(verified)',
      'filterOnly(rating)',
      'filterOnly(deliveryAvailable)',
      'filterOnly(hub)',
    ],
    customRanking: [
      'desc(verified)',
      'desc(_popularityScore)',
      'desc(rating)',
      'desc(reviewCount)',
    ],
    typoTolerance: true,
    advancedSyntax: true,
    hitsPerPage: 24,
  },

  sokoni_services: {
    searchableAttributes: [
      'unordered(name)',
      'unordered(description)',
      'unordered(category,subcategory)',
      'tags,skills',
      'unordered(location.city,location.county)',
    ],
    attributesForFaceting: [
      'searchable(category)',
      'filterOnly(price)',
      'searchable(location.city)',
      'filterOnly(rating)',
      'filterOnly(verified)',
      'filterOnly(availability)',
    ],
    customRanking: [
      'desc(verified)',
      'desc(_popularityScore)',
      'desc(rating)',
    ],
    typoTolerance: true,
    hitsPerPage: 24,
  },

  sokoni_jobs: {
    searchableAttributes: [
      'unordered(title)',
      'unordered(company)',
      'unordered(description)',
      'unordered(skills)',
      'unordered(location.city,location.county)',
      'category',
    ],
    attributesForFaceting: [
      'searchable(category)',
      'filterOnly(salary)',
      'searchable(location.city)',
      'searchable(location.county)',
      'filterOnly(jobType)',
      'filterOnly(experienceLevel)',
      'filterOnly(remote)',
    ],
    customRanking: [
      'desc(_freshnessScore)',
      'desc(_popularityScore)',
    ],
    typoTolerance: true,
    hitsPerPage: 20,
  },

  sokoni_vehicles: {
    searchableAttributes: [
      'unordered(make,model)',
      'unordered(description)',
      'year',
      'unordered(location.city,location.county)',
      'tags',
    ],
    attributesForFaceting: [
      'filterOnly(price)',
      'searchable(make)',
      'filterOnly(model)',
      'filterOnly(year)',
      'filterOnly(fuel)',
      'filterOnly(transmission)',
      'filterOnly(bodyType)',
      'searchable(location.city)',
      'filterOnly(condition)',
      'filterOnly(mileage)',
    ],
    customRanking: [
      'desc(_popularityScore)',
      'desc(isFeatured)',
      'desc(rating)',
    ],
    typoTolerance: true,
    hitsPerPage: 20,
  },

  sokoni_properties: {
    searchableAttributes: [
      'unordered(title)',
      'unordered(description)',
      'unordered(type)',
      'unordered(location.city,location.county,location.area)',
      'tags',
    ],
    attributesForFaceting: [
      'filterOnly(price)',
      'filterOnly(type)',
      'searchable(location.city)',
      'searchable(location.county)',
      'filterOnly(bedrooms)',
      'filterOnly(bathrooms)',
      'filterOnly(tenure)',
      'filterOnly(furnished)',
      'filterOnly(petFriendly)',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(_popularityScore)',
    ],
    typoTolerance: true,
    hitsPerPage: 20,
  },

  sokoni_events: {
    searchableAttributes: [
      'unordered(name)',
      'unordered(description)',
      'unordered(category)',
      'organizer.name',
      'unordered(location.city,location.county,venue)',
      'tags',
    ],
    attributesForFaceting: [
      'searchable(category)',
      'filterOnly(price)',
      'searchable(location.city)',
      'filterOnly(isOnline)',
      'filterOnly(isFree)',
    ],
    customRanking: [
      'asc(startAt)',
      'desc(isFeatured)',
      'desc(_popularityScore)',
    ],
    typoTolerance: true,
    hitsPerPage: 24,
  },

  global_search: {
    searchableAttributes: [
      'unordered(title)',
      'unordered(description)',
      'unordered(category)',
      'unordered(city,county)',
      'type',
    ],
    attributesForFaceting: [
      'searchable(type)',
      'searchable(category)',
      'searchable(city)',
      'filterOnly(price)',
      'filterOnly(verified)',
    ],
    customRanking: [
      'desc(_popularityScore)',
      'desc(_qualityScore)',
      'desc(verified)',
      'desc(_freshnessScore)',
    ],
    typoTolerance: true,
    hitsPerPage: 30,
  },

};

/* Ordered list of all expected index names */
const EXPECTED_INDEXES = Object.keys(INDEX_SETTINGS);

/* ═══════════════════════════════════════════════════════════════════════════
   KENYAN MARKETPLACE SYNONYMS
════════════════════════════════════════════════════════════════════════════ */

const KENYAN_SYNONYMS = [
  { objectID: 'syn-nguo',      type: 'synonym', synonyms: ['nguo','clothes','clothing','fashion','garments'] },
  { objectID: 'syn-chakula',   type: 'synonym', synonyms: ['chakula','food','meals','restaurant','dining'] },
  { objectID: 'syn-nyumba',    type: 'synonym', synonyms: ['nyumba','house','home','property','apartment'] },
  { objectID: 'syn-gari',      type: 'synonym', synonyms: ['gari','car','vehicle','auto','automobile'] },
  { objectID: 'syn-kazi',      type: 'synonym', synonyms: ['kazi','job','work','employment','career','vacancy'] },
  { objectID: 'syn-simu',      type: 'synonym', synonyms: ['simu','phone','mobile','smartphone','handset'] },
  { objectID: 'syn-mzigo',     type: 'synonym', synonyms: ['mzigo','delivery','courier','logistics','shipping'] },
  { objectID: 'syn-dawa',      type: 'synonym', synonyms: ['dawa','medicine','pharmacy','drugs','medication'] },
  { objectID: 'syn-pesa',      type: 'synonym', synonyms: ['pesa','money','payment','finance','cash'] },
  { objectID: 'syn-shule',     type: 'synonym', synonyms: ['shule','school','education','college','university'] },
  { objectID: 'syn-nairobi',   type: 'synonym', synonyms: ['nairobi','nbi','cbd','city'] },
  { objectID: 'syn-mombasa',   type: 'synonym', synonyms: ['mombasa','msasa','coast'] },
  { objectID: 'syn-kisumu',    type: 'synonym', synonyms: ['kisumu','lake city','lakeside'] },
  { objectID: 'syn-wifi',      type: 'synonym', synonyms: ['wifi','internet','wireless','broadband'] },
  { objectID: 'syn-laptop',    type: 'synonym', synonyms: ['laptop','computer','pc','notebook'] },
  { objectID: 'syn-tv',        type: 'synonym', synonyms: ['tv','television','screen','monitor'] },
  { objectID: 'syn-fridge',    type: 'synonym', synonyms: ['fridge','refrigerator','freezer','cooler'] },
  { objectID: 'syn-sofa',      type: 'synonym', synonyms: ['sofa','couch','settee','seat'] },
  { objectID: 'syn-bodaboda',  type: 'synonym', synonyms: ['boda boda','motorcycle','motorbike','piki piki'] },
  { objectID: 'syn-matatu',    type: 'synonym', synonyms: ['matatu','bus','shuttle','minibus','psa'] },
];

/* ═══════════════════════════════════════════════════════════════════════════
   QUERY RULES
   Applied only to indexes where they are relevant.
════════════════════════════════════════════════════════════════════════════ */

const INDEX_RULES = [
  {
    objectID:    'boost-verified-sellers',
    conditions:  [{ pattern: '', anchoring: 'is' }],
    consequence: {
      params: {
        optionalFilters: ['seller.verified:true<score=3>'],
      },
    },
    description: 'Boost verified sellers in results',
  },
  {
    objectID:    'boost-in-stock',
    conditions:  [{ pattern: '', anchoring: 'is' }],
    consequence: {
      params: {
        optionalFilters: ['inStock:true<score=2>'],
      },
    },
    description: 'Boost in-stock items',
  },
  {
    objectID:    'boost-featured',
    conditions:  [{ pattern: '', anchoring: 'is' }],
    consequence: {
      params: {
        optionalFilters: ['isFeatured:true<score=5>'],
      },
    },
    description: 'Boost featured/sponsored items',
  },
];

/* Rules only apply where the underlying fields exist */
const RULE_TARGET_INDEXES = ['sokoni_products', 'sokoni_shops'];

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORTED CLOUD FUNCTIONS
════════════════════════════════════════════════════════════════════════════ */

/**
 * searchApplyIndexSettings
 * Admin-only onCall that applies the INDEX_SETTINGS configuration to one or
 * more existing Algolia indexes. Does NOT create indexes.
 *
 * Request body: { indexes?: string[] }  — omit to apply to all 8 indexes.
 * Returns: { applied: string[], errors: Array<{index, error}> }
 */
const searchApplyIndexSettings = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 120 },
  async (req) => {
    const uid = _assertAdmin(req);
    const db  = admin.firestore();

    const requested = Array.isArray(req.data?.indexes)
      ? req.data.indexes.filter(i => EXPECTED_INDEXES.includes(i))
      : EXPECTED_INDEXES;

    const algolia  = _client();
    const applied  = [];
    const errors   = [];

    for (const indexName of requested) {
      const settings = INDEX_SETTINGS[indexName];
      if (!settings) {
        errors.push({ index: indexName, error: 'No settings defined for this index' });
        continue;
      }
      try {
        await algolia.setIndexSettings(indexName, settings);
        applied.push(indexName);
      } catch (err) {
        errors.push({ index: indexName, error: err.message });
      }
    }

    // Audit trail
    await db.collection('adminAuditLog').add({
      action:    'searchApplyIndexSettings',
      uid,
      applied,
      errors,
      indexCount: applied.length,
      timestamp:  admin.firestore.FieldValue.serverTimestamp(),
    });

    return { applied, errors };
  }
);

/**
 * searchValidateIndexes
 * Admin-only onCall that verifies all expected Algolia indexes exist and
 * returns their current statistics.
 *
 * Returns: { valid: bool, existingIndexes: string[], missingIndexes: string[], indexStats: object }
 */
const searchValidateIndexes = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 60 },
  async (req) => {
    _assertAdmin(req);

    const algolia = _client();

    let listResult;
    try {
      listResult = await algolia.listIndexes();
    } catch (err) {
      throw new HttpsError('internal', `Failed to list Algolia indexes: ${err.message}`);
    }

    // Algolia returns { items: [{ name, entries, dataSize, ... }] }
    const remoteItems       = listResult.items || [];
    const remoteNames       = new Set(remoteItems.map(i => i.name));
    const existingIndexes   = EXPECTED_INDEXES.filter(n => remoteNames.has(n));
    const missingIndexes    = EXPECTED_INDEXES.filter(n => !remoteNames.has(n));

    const indexStats = {};
    for (const item of remoteItems) {
      if (EXPECTED_INDEXES.includes(item.name)) {
        indexStats[item.name] = {
          entries:      item.entries  || 0,
          dataSize:     item.dataSize || 0,
          lastBuildTimeS: item.lastBuildTimeS || 0,
          updatedAt:    item.updatedAt || null,
        };
      }
    }

    return {
      valid:          missingIndexes.length === 0,
      existingIndexes,
      missingIndexes,
      indexStats,
    };
  }
);

/**
 * searchApplySynonyms
 * Admin-only onCall that applies all KENYAN_SYNONYMS to every expected index.
 * Uses replaceExistingSynonyms=false to preserve any manually added synonyms.
 *
 * Returns: { appliedToIndexes: string[], synonymCount: number, errors: Array<{index, error}> }
 */
const searchApplySynonyms = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 120 },
  async (req) => {
    const uid = _assertAdmin(req);
    const db  = admin.firestore();

    const algolia         = _client();
    const appliedToIndexes = [];
    const errors          = [];

    for (const indexName of EXPECTED_INDEXES) {
      try {
        // AlgoliaClient.saveSynonyms signature: (indexName, synonyms, replaceAll)
        await algolia.saveSynonyms(indexName, KENYAN_SYNONYMS, false);
        appliedToIndexes.push(indexName);
      } catch (err) {
        errors.push({ index: indexName, error: err.message });
      }
    }

    await db.collection('adminAuditLog').add({
      action:           'searchApplySynonyms',
      uid,
      appliedToIndexes,
      synonymCount:     KENYAN_SYNONYMS.length,
      errors,
      timestamp:        admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      appliedToIndexes,
      synonymCount: KENYAN_SYNONYMS.length,
      errors,
    };
  }
);

/**
 * searchApplyRules
 * Admin-only onCall that applies the three standard query rules to the target
 * indexes (sokoni_products and sokoni_shops only — other indexes lack the fields
 * referenced by the rules).
 *
 * Returns: { appliedToIndexes: string[], ruleCount: number, errors: Array<{index, error}> }
 */
const searchApplyRules = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 60 },
  async (req) => {
    const uid = _assertAdmin(req);
    const db  = admin.firestore();

    const algolia          = _client();
    const appliedToIndexes = [];
    const errors           = [];

    for (const indexName of RULE_TARGET_INDEXES) {
      try {
        // AlgoliaClient.saveRules signature: (indexName, rules, replaceAll)
        // replaceAll=false: merge with existing rules rather than wiping them
        await algolia.saveRules(indexName, INDEX_RULES, false);
        appliedToIndexes.push(indexName);
      } catch (err) {
        errors.push({ index: indexName, error: err.message });
      }
    }

    await db.collection('adminAuditLog').add({
      action:           'searchApplyRules',
      uid,
      appliedToIndexes,
      ruleCount:        INDEX_RULES.length,
      errors,
      timestamp:        admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      appliedToIndexes,
      ruleCount: INDEX_RULES.length,
      errors,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORTS
════════════════════════════════════════════════════════════════════════════ */

module.exports = {
  searchApplyIndexSettings,
  searchValidateIndexes,
  searchApplySynonyms,
  searchApplyRules,
  /* Static config exported for tests and documentation */
  INDEX_SETTINGS,
  KENYAN_SYNONYMS,
};
