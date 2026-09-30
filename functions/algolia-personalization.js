/**
 * SOKONI Algolia Personalization
 *
 * Manages the Algolia Personalization API:
 *   - Personalization strategy (event weights + facet weights)
 *   - User profile lookup
 *   - GDPR deletion (deleteUserProfile)
 *   - User token ↔ uid mapping for server-side profile merging
 *
 * Personalization strategy is configured once and applies automatically
 * to all queries where `enablePersonalization: true` is set.
 *
 * Algolia Personalization API region: 'us' (default) — change via
 * ALGOLIA_PERSONALIZATION_REGION env variable if on EU data center.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

const { AlgoliaClient }      = require('./algolia-indexer');

const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

const REGION = process.env.ALGOLIA_PERSONALIZATION_REGION || 'us';

function _client() {
  const appId = process.env.ALGOLIA_APP_ID;
  const key   = ALGOLIA_ADMIN_KEY.value();
  if (!appId || !key || key === 'not_configured') return null;
  return new AlgoliaClient(appId, key);
}

function _assertAdmin(request) {
  if (!request.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only.');
}

/* ── SOKONI Personalization Strategy ─────────────────────────────────── */

const SOKONI_PERSONALIZATION_STRATEGY = {
  eventsScoring: [
    /* Click events — low weight; intent is uncertain */
    { eventName: 'Product Clicked',                      eventType: 'click',      score: 1  },
    { eventName: 'Object Clicked',                       eventType: 'click',      score: 1  },
    { eventName: 'Filter Clicked',                       eventType: 'click',      score: 2  },
    { eventName: 'Recommend Product Clicked',            eventType: 'click',      score: 1  },
    /* View events — signals interest */
    { eventName: 'Objects Viewed',                       eventType: 'view',       score: 1  },
    { eventName: 'Filters Viewed',                       eventType: 'view',       score: 1  },
    /* Cart events — strong purchase intent */
    { eventName: 'Product Added To Cart',                eventType: 'conversion', score: 5  },
    { eventName: 'Product Added To Cart After Search',   eventType: 'conversion', score: 6  },
    { eventName: 'Recommend Product Added To Cart',      eventType: 'conversion', score: 4  },
    /* Purchase events — highest signal */
    { eventName: 'Product Purchased',                    eventType: 'conversion', score: 10 },
    { eventName: 'Product Purchased After Search',       eventType: 'conversion', score: 12 },
    { eventName: 'Recommend Product Purchased',          eventType: 'conversion', score: 8  },
  ],
  facetsScoring: [
    /* Hub affinity is the strongest signal — user prefers specific verticals */
    { facetName: 'hub',               score: 40 },
    /* Category and subcategory are highly specific */
    { facetName: 'category',          score: 30 },
    { facetName: 'subcategory',       score: 20 },
    /* Brand loyalty is strong in repeat shoppers */
    { facetName: 'brand',             score: 25 },
    /* Location signals convenience preference */
    { facetName: 'location.city',     score: 15 },
    { facetName: 'location.county',   score: 10 },
    /* Job / service type preferences */
    { facetName: 'jobType',           score: 15 },
    { facetName: 'remote',            score: 10 },
    { facetName: 'priceType',         score: 8  },
    /* Delivery preference */
    { facetName: 'deliveryOptions',   score: 8  },
  ],
  /* Weight of personalization vs textual relevance (0-100; 100 = fully personalised) */
  personalizationImpact: 75,
};

/* ══════════════════════════════════════════════════════════════════════
   setAlgoliaPersonalizationStrategy  — deploy strategy to Algolia
══════════════════════════════════════════════════════════════════════ */

const setAlgoliaPersonalizationStrategy = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 30 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    /* Allow admin to supply a custom strategy or fall back to SOKONI default */
    const strategy = request.data?.strategy || SOKONI_PERSONALIZATION_STRATEGY;

    try {
      await algolia.setPersonalizationStrategy(strategy, REGION);

      await _db().collection('adminAuditLogs').add({
        action:    'algolia_set_personalization_strategy',
        by:        request.auth.uid,
        strategy,
        createdAt: _now(),
      });

      /* Cache in Firestore so UI can show without making an Algolia call */
      await _db().doc('algoliaConfig/personalizationStrategy').set({
        strategy,
        updatedAt: _now(),
        updatedBy: request.auth.uid,
      });

      return { ok: true, strategy };
    } catch (err) {
      console.error('[AlgoliaPersonalization] Strategy set failed:', err.message);
      throw new HttpsError('internal', err.message);
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaPersonalizationStrategy  — retrieve current strategy
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaPersonalizationStrategy = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    try {
      const strategy = await algolia.getPersonalizationStrategy(REGION);
      return { ok: true, strategy };
    } catch (err) {
      /* Fallback to cached Firestore copy */
      const cached = await _db().doc('algoliaConfig/personalizationStrategy').get();
      if (cached.exists) return { ok: true, strategy: cached.data()?.strategy, cached: true };
      throw new HttpsError('internal', err.message);
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaUserProfile  — fetch personalization profile for a user
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaUserProfile = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10, cors: true },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Must be signed in.');

    const algolia = _client();
    if (!algolia) return { ok: false, profile: null };

    /* Use the uid as userToken — this matches what we inject into secured keys */
    const userToken = request.data?.userToken || request.auth.uid;

    try {
      const profile = await algolia.getUserProfile(userToken, REGION);
      return { ok: true, profile };
    } catch (err) {
      if (err.status === 404) return { ok: true, profile: null, message: 'No profile yet — start browsing to build one.' };
      console.error('[AlgoliaPersonalization] Profile fetch failed:', err.message);
      return { ok: false, profile: null };
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════
   deleteAlgoliaUserProfile  — GDPR right-to-erasure
══════════════════════════════════════════════════════════════════════ */

const deleteAlgoliaUserProfile = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    /* User can delete their own; admin can delete any */
    const uid       = request.auth?.uid;
    const targetUid = request.data?.targetUid || uid;

    if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in.');
    if (targetUid !== uid && !request.auth?.token?.admin) {
      throw new HttpsError('permission-denied', 'Can only delete your own profile unless admin.');
    }

    const algolia = _client();
    if (!algolia) return { ok: true, message: 'Algolia not configured — no profile to delete.' };

    try {
      await algolia.deleteUserProfile(targetUid, REGION);

      await _db().collection('adminAuditLogs').add({
        action:    'algolia_delete_user_profile',
        targetUid,
        by:        uid,
        createdAt: _now(),
      });

      return { ok: true, message: 'Algolia personalization profile deleted.' };
    } catch (err) {
      if (err.status === 404) return { ok: true, message: 'No profile existed.' };
      console.error('[AlgoliaPersonalization] Profile delete failed:', err.message);
      throw new HttpsError('internal', err.message);
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaPersonalizationStatus  — admin: current strategy + impact
══════════════════════════════════════════════════════════════════════ */

const algoliaPersonalizationStatus = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const [strategyResult, cachedConfig] = await Promise.allSettled([
      algolia.getPersonalizationStrategy(REGION),
      _db().doc('algoliaConfig/personalizationStrategy').get(),
    ]);

    const strategy = strategyResult.status === 'fulfilled'
      ? strategyResult.value
      : (cachedConfig.status === 'fulfilled' && cachedConfig.value.exists
          ? cachedConfig.value.data()?.strategy
          : null);

    return {
      ok:       true,
      strategy,
      live:     strategyResult.status === 'fulfilled',
      checkedAt: new Date().toISOString(),
    };
  }
);

module.exports = {
  setAlgoliaPersonalizationStrategy,
  getAlgoliaPersonalizationStrategy,
  getAlgoliaUserProfile,
  deleteAlgoliaUserProfile,
  algoliaPersonalizationStatus,
  SOKONI_PERSONALIZATION_STRATEGY,
};
