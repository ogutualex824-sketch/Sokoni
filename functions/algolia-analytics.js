/**
 * SOKONI Algolia Analytics Aggregation
 *
 * Captures search behavior signals and aggregates them for:
 *  - Admin dashboard: top searches, zero results, CTR, conversion
 *  - AI ranking signals: feeds back into Algolia custom ranking
 *  - Trending: powers the "Trending Now" section
 *  - Recommendations: informs personalization
 *
 * Two data flows:
 *   1. Client → recordSearchEvent (callable) → algoliaSearchEvents Firestore
 *   2. aggregateSearchAnalytics (scheduled daily) → aggregates → searchAnalytics/
 *
 * Event types: search, click, conversion, no_results, filter_use
 */

'use strict';

const { onCall, HttpsError }           = require('firebase-functions/v2/https');
const { onSchedule }                   = require('firebase-functions/v2/scheduler');
const { onDocumentCreated }            = require('firebase-functions/v2/firestore');
const { defineSecret }                 = require('firebase-functions/params');
const admin                            = require('firebase-admin');

const { AlgoliaClient }                = require('./algolia-indexer');

const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');

function _algoliaClient() {
  const appId = process.env.ALGOLIA_APP_ID;
  const key   = ALGOLIA_ADMIN_KEY.value();
  if (!appId || !key || key === 'not_configured') return null;
  return new AlgoliaClient(appId, key);
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }
function _inc(n = 1) { return admin.firestore.FieldValue.increment(n); }

/* ══════════════════════════════════════════════════════════════════════
   recordSearchEvent  — lightweight client-side event collector
══════════════════════════════════════════════════════════════════════ */

const recordSearchEvent = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 10, cors: true },
  async (request) => {
    const {
      type, query, indexName, objectIDs, queryID, positions, filters, resultCount,
      /* Extended Insights fields */
      eventSubtype,      // 'addToCart' | 'purchase'
      currency,          // 'KES'
      value,             // order total in KES
      objectData,        // [{ price, discount, quantity }] for purchase events
      eventName: customName,  // optional override for the event name in Algolia
    } = request.data || {};

    const VALID_TYPES = ['search', 'click', 'conversion', 'no_results', 'filter_use', 'view',
                         'add_to_cart', 'purchase', 'viewed_filters', 'clicked_filters'];
    if (!VALID_TYPES.includes(type)) throw new HttpsError('invalid-argument', 'Invalid event type.');

    /* Prevent Firestore batch overflow: aggregator writes 1 doc per objectID.
       Firestore batch limit is 500 ops; we cap at 50 to leave headroom. */
    if (Array.isArray(objectIDs) && objectIDs.length > 50) {
      throw new HttpsError('invalid-argument', 'objectIDs may not exceed 50 items per event.');
    }

    const uid       = request.auth?.uid || null;
    const userToken = uid || `anon_${request.rawRequest?.ip?.replace(/[.:]/g, '_') || 'x'}`;
    const q         = (query || '').toLowerCase().trim().slice(0, 200);
    const today     = new Date().toISOString().slice(0, 10);
    const idxName   = indexName || 'sokoni_products';

    const event = {
      type,
      query:        q,
      queryID:      queryID      || null,
      indexName:    idxName,
      objectIDs:    objectIDs    || [],
      positions:    positions    || [],
      filters:      filters      || {},
      resultCount:  resultCount  ?? null,
      eventSubtype: eventSubtype || null,
      currency:     currency     || 'KES',
      value:        value        ?? null,
      userToken,
      uid,
      ts:           _now(),
      date:         today,
    };

    /* Write raw event to Firestore (triggers local aggregator) */
    const fsWrite = _db().collection('algoliaSearchEvents').add(event);

    /* Forward full Insights event to Algolia in parallel (non-blocking on failure) */
    const algoliaInsightsForward = (async () => {
      const algolia = _algoliaClient();
      if (!algolia) return;

      const ts = Date.now();
      const insightsEvent = {
        eventType:  _mapEventType(type),
        eventName:  customName || _defaultEventName(type, eventSubtype),
        index:      idxName,
        userToken,
        timestamp:  ts,
        queryID:    queryID || undefined,
        objectIDs:  (objectIDs && objectIDs.length) ? objectIDs : undefined,
        positions:  (positions && positions.length) ? positions : undefined,
        filters:    filters   ? Object.entries(filters).map(([k, v]) => `${k}:${v}`) : undefined,
        currency:   (type === 'purchase' || type === 'add_to_cart') ? (currency || 'KES') : undefined,
        value:      value !== undefined ? value : undefined,
        objectData: objectData || undefined,
      };

      /* Set eventSubtype for add-to-cart and purchase */
      if (type === 'add_to_cart') { insightsEvent.eventType = 'conversion'; insightsEvent.eventSubtype = 'addToCart'; }
      if (type === 'purchase')    { insightsEvent.eventType = 'conversion'; insightsEvent.eventSubtype = 'purchase'; }

      /* Strip undefined fields */
      Object.keys(insightsEvent).forEach(k => insightsEvent[k] === undefined && delete insightsEvent[k]);

      await algolia.sendEvents([insightsEvent]).catch(err => {
        console.warn('[AlgoliaInsights] Forward failed:', err.message);
      });
    })();

    await Promise.all([fsWrite, algoliaInsightsForward]);

    return { ok: true };
  }
);

function _mapEventType(type) {
  if (type === 'click' || type === 'clicked_filters') return 'click';
  if (type === 'conversion' || type === 'add_to_cart' || type === 'purchase') return 'conversion';
  return 'view';
}

function _defaultEventName(type, eventSubtype) {
  const names = {
    search:          'Search Performed',
    click:           'Product Clicked',
    conversion:      eventSubtype === 'addToCart' ? 'Product Added To Cart' : 'Product Purchased',
    add_to_cart:     'Product Added To Cart',
    purchase:        'Product Purchased',
    no_results:      'No Results Shown',
    filter_use:      'Filter Applied',
    view:            'Objects Viewed',
    viewed_filters:  'Filters Viewed',
    clicked_filters: 'Filter Clicked',
  };
  return names[type] || 'Search Event';
}

/* ══════════════════════════════════════════════════════════════════════
   Real-time aggregation trigger — fires on each new event
══════════════════════════════════════════════════════════════════════ */

const algoliaEventAggregator = onDocumentCreated(
  { document: 'algoliaSearchEvents/{eventId}', timeoutSeconds: 30 },
  async (event) => {
    const data  = event.data?.data();
    if (!data) return;

    const db    = _db();
    const today = data.date || new Date().toISOString().slice(0, 10);
    const q     = data.query;

    const dailyRef = db.collection('searchAnalytics').doc(`daily_${today}`);
    const batch    = db.batch();

    switch (data.type) {
      case 'search':
        /* Increment total search count */
        batch.set(dailyRef, { totalSearches: _inc(), date: today }, { merge: true });
        /* Track per-query count */
        if (q) {
          const qRef = db.collection('searchQueryStats').doc(encodeQuery(q));
          batch.set(qRef, {
            query:       q,
            count:       _inc(),
            lastSearchAt: _now(),
            resultCount: data.resultCount ?? 0,
          }, { merge: true });
        }
        /* Zero-result tracking */
        if (data.resultCount === 0 && q) {
          const zRef = db.collection('searchZeroResults').doc(encodeQuery(q));
          batch.set(zRef, {
            query:    q,
            count:    _inc(),
            lastSeenAt: _now(),
          }, { merge: true });
          batch.set(dailyRef, { totalZeroResults: _inc() }, { merge: true });
        }
        break;

      case 'click':
        batch.set(dailyRef, { totalClicks: _inc() }, { merge: true });
        if (data.objectIDs?.length) {
          for (const objectID of data.objectIDs) {
            const cRef = db.collection('searchClickStats').doc(objectID);
            batch.set(cRef, { objectID, clicks: _inc(), lastClickAt: _now() }, { merge: true });
          }
        }
        break;

      case 'conversion':
        batch.set(dailyRef, { totalConversions: _inc() }, { merge: true });
        if (data.objectIDs?.length) {
          for (const objectID of data.objectIDs) {
            const cRef = db.collection('searchClickStats').doc(objectID);
            batch.set(cRef, { conversions: _inc() }, { merge: true });
          }
        }
        break;

      case 'no_results':
        batch.set(dailyRef, { totalNoResults: _inc() }, { merge: true });
        break;

      case 'filter_use':
      case 'clicked_filters':
        batch.set(dailyRef, { totalFilteredSearches: _inc() }, { merge: true });
        if (data.filters) {
          for (const [attr, val] of Object.entries(data.filters)) {
            const fRef = db.collection('searchFilterStats').doc(`${attr}_${String(val).slice(0, 80)}`);
            batch.set(fRef, { attribute: attr, value: String(val), count: _inc(), lastUsedAt: _now() }, { merge: true });
          }
        }
        break;

      case 'add_to_cart':
        batch.set(dailyRef, { totalAddToCart: _inc() }, { merge: true });
        if (data.objectIDs?.length) {
          for (const objectID of data.objectIDs) {
            const cRef = db.collection('searchClickStats').doc(objectID);
            batch.set(cRef, { objectID, addToCart: _inc() }, { merge: true });
          }
        }
        break;

      case 'purchase':
        batch.set(dailyRef, {
          totalPurchases: _inc(),
          totalRevenue:   _inc(data.value || 0),
        }, { merge: true });
        if (data.objectIDs?.length) {
          for (const objectID of data.objectIDs) {
            const cRef = db.collection('searchClickStats').doc(objectID);
            batch.set(cRef, { objectID, purchases: _inc() }, { merge: true });
          }
        }
        break;

      case 'view':
      case 'viewed_filters':
        batch.set(dailyRef, { totalViews: _inc() }, { merge: true });
        break;
    }

    await batch.commit();
  }
);

/* ══════════════════════════════════════════════════════════════════════
   aggregateSearchAnalytics  — scheduled daily rollup
══════════════════════════════════════════════════════════════════════ */

const aggregateSearchAnalytics = onSchedule(
  {
    schedule:       'every day 02:00',
    timeoutSeconds: 300,
    memory:         '512MiB',
    secrets:        [ALGOLIA_ADMIN_KEY],
  },
  async () => {
    const db      = _db();
    const today   = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    /* ── 1–4. Parallel Firestore reads (was sequential — 4× latency) ── */
    const [topSearchSnap, zeroSnap, clickSnap, filterSnap] = await Promise.all([
      db.collection('searchQueryStats').orderBy('count', 'desc').limit(100).get(),
      db.collection('searchZeroResults').orderBy('count', 'desc').limit(50).get(),
      db.collection('searchClickStats').orderBy('clicks', 'desc').limit(100).get(),
      db.collection('searchFilterStats').orderBy('count', 'desc').limit(50).get(),
    ]);

    const topSearches = topSearchSnap.docs.map(d => ({
      query:       d.data().query,
      count:       d.data().count,
      resultCount: d.data().resultCount,
    }));

    const zeroResults = zeroSnap.docs.map(d => ({
      query: d.data().query,
      count: d.data().count,
    }));

    const topClicked = clickSnap.docs.map(d => ({
      objectID:    d.data().objectID,
      clicks:      d.data().clicks,
      conversions: d.data().conversions || 0,
      ctr:         d.data().clicks ? (d.data().conversions || 0) / d.data().clicks : 0,
    }));

    const topFilters = filterSnap.docs.map(d => ({  // filterSnap already resolved in Promise.all above
      attribute: d.data().attribute,
      value:     d.data().value,
      count:     d.data().count,
    }));

    /* ── 5. Daily summary ────────────────────────────────────────────── */
    const yesterdayRef = db.collection('searchAnalytics').doc(`daily_${yesterday}`);
    const dailySnap    = await yesterdayRef.get();
    const dailyData    = dailySnap.exists ? dailySnap.data() : {};

    /* ── 6. Save aggregated report ───────────────────────────────────── */
    const report = {
      date:         today,
      generatedAt:  _now(),
      daily: {
        date:                yesterday,
        totalSearches:       dailyData.totalSearches       || 0,
        totalClicks:         dailyData.totalClicks         || 0,
        totalConversions:    dailyData.totalConversions    || 0,
        totalZeroResults:    dailyData.totalZeroResults    || 0,
        totalNoResults:      dailyData.totalNoResults      || 0,
        totalFilteredSearches: dailyData.totalFilteredSearches || 0,
        totalAddToCart:      dailyData.totalAddToCart      || 0,
        totalPurchases:      dailyData.totalPurchases      || 0,
        totalRevenue:        dailyData.totalRevenue        || 0,
        totalViews:          dailyData.totalViews          || 0,
        ctr: dailyData.totalSearches
          ? (dailyData.totalClicks || 0) / dailyData.totalSearches
          : 0,
        conversionRate: dailyData.totalClicks
          ? (dailyData.totalConversions || 0) / dailyData.totalClicks
          : 0,
        addToCartRate: dailyData.totalClicks
          ? (dailyData.totalAddToCart || 0) / dailyData.totalClicks
          : 0,
        zeroResultRate: dailyData.totalSearches
          ? (dailyData.totalZeroResults || 0) / dailyData.totalSearches
          : 0,
        avgOrderValue: dailyData.totalPurchases
          ? (dailyData.totalRevenue || 0) / dailyData.totalPurchases
          : 0,
      },
      topSearches:  topSearches.slice(0, 20),
      zeroResults:  zeroResults.slice(0, 20),
      topClicked:   topClicked.slice(0, 20),
      topFilters:   topFilters.slice(0, 20),
    };

    await db.collection('searchAnalytics').doc('latest').set(report);
    await db.collection('searchAnalytics').doc(`report_${yesterday}`).set(report);

    /* ── 7. Generate trending signals ───────────────────────────────── */
    await _generateTrending(db, topClicked, topSearches);

    console.log(`[AlgoliaAnalytics] Daily report generated for ${yesterday}`);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   generateTrending  — writes to trending Firestore collection
══════════════════════════════════════════════════════════════════════ */

async function _generateTrending(db, topClicked, topSearches) {
  const batch = db.batch();
  const now   = _now();

  /* Trending products */
  topClicked.slice(0, 30).forEach((item, i) => {
    const ref = db.collection('trending').doc(`product_${item.objectID}`);
    batch.set(ref, {
      type:       'product',
      objectID:   item.objectID,
      score:      item.clicks * 3 + (item.conversions || 0) * 10,
      rank:       i + 1,
      clicks:     item.clicks,
      conversions: item.conversions || 0,
      updatedAt:  now,
    }, { merge: true });
  });

  /* Trending searches */
  topSearches.slice(0, 20).forEach((item, i) => {
    const ref = db.collection('trending').doc(`query_${encodeQuery(item.query)}`);
    batch.set(ref, {
      type:      'query',
      query:     item.query,
      count:     item.count,
      rank:      i + 1,
      updatedAt: now,
    }, { merge: true });
  });

  await batch.commit();
}

/* ══════════════════════════════════════════════════════════════════════
   getSearchAnalytics  — admin dashboard data
══════════════════════════════════════════════════════════════════════ */

const getSearchAnalytics = onCall(
  { timeoutSeconds: 15 },
  async (request) => {
    if (!request.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only.');
    const db   = _db();
    const snap = await db.collection('searchAnalytics').doc('latest').get();
    return snap.exists ? snap.data() : { empty: true };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   getTrendingSearches  — public: powers autocomplete suggestions
══════════════════════════════════════════════════════════════════════ */

const getTrendingSearches = onCall(
  { timeoutSeconds: 10, cors: true },
  async (request) => {
    const { limit = 10 } = request.data || {};
    const db = _db();
    const snap = await db.collection('trending')
      .where('type', '==', 'query')
      .orderBy('rank')
      .limit(Math.min(limit, 20))
      .get();
    return {
      trending: snap.docs.map(d => ({
        query: d.data().query,
        count: d.data().count,
        rank:  d.data().rank,
      })),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   Cleanup — purge raw events older than 90 days
══════════════════════════════════════════════════════════════════════ */

const algoliaAnalyticsCleanup = onSchedule(
  { schedule: 'every sunday 03:00', timeoutSeconds: 300 },
  async () => {
    const db     = _db();
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 90 * 86_400_000);

    const snap = await db.collection('algoliaSearchEvents')
      .where('ts', '<', cutoff)
      .limit(2000)
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`[AlgoliaAnalytics] Purged ${snap.size} old events`);
  }
);

/* ── Utility ──────────────────────────────────────────────────────────── */

function encodeQuery(q) {
  return q.slice(0, 100).replace(/[^a-z0-9_\-]/gi, '_').toLowerCase();
}

module.exports = {
  recordSearchEvent,
  algoliaEventAggregator,
  aggregateSearchAnalytics,
  getSearchAnalytics,
  getTrendingSearches,
  algoliaAnalyticsCleanup,
};
