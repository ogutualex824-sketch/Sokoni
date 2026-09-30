/**
 * SOKONI Typesense Search Analytics
 *
 * Captures, aggregates, and surfaces search behaviour:
 *  - recordTypesenseSearchEvent  — onCall, client submits search events
 *  - tsEventAggregator           — onDocumentCreated, real-time rollup
 *  - aggregateTypesenseAnalytics — daily 02:30, produces summary reports
 *  - getTypesenseAnalytics       — admin callable, returns current stats
 *  - getTsAutocompleteSuggestions— public callable, powers autocomplete
 *  - typesenseAnalyticsCleanup   — weekly, purges old raw events
 */

'use strict';

const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { onDocumentCreated }        = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const EVENTS_COL       = 'tsSearchEvents';
const ANALYTICS_COL    = 'tsAnalytics';
const QUERY_STATS_COL  = 'tsQueryStats';
const ZERO_RESULTS_COL = 'tsZeroResults';
const CLICK_STATS_COL  = 'tsClickStats';
const FILTER_STATS_COL = 'tsFilterStats';
const TRENDING_COL     = 'tsTrending';

const VALID_TYPES = new Set(['search', 'click', 'conversion', 'autocomplete', 'voice', 'geo']);

/* All valid Typesense collection names — prevents collection field injection */
const VALID_COLLECTIONS = new Set([
  'sokoni_products', 'sokoni_shops',    'sokoni_services',
  'sokoni_events',   'sokoni_properties','sokoni_vehicles',
  'sokoni_jobs',     'sokoni_users',    'sokoni_categories',
  'sokoni_brands',   'sokoni_collections','sokoni_coupons',
  'sokoni_hotels',   'sokoni_restaurants','sokoni_sports',
  'sokoni_healthcare','sokoni_education','sokoni_professionals',
  'sokoni_reviews',  'sokoni_support',  'sokoni_faq',
  'sokoni_blog',     'sokoni_announcements','sokoni_tourism',
  'sokoni_entertainment',
]);

/* Rate-limit config: max events per user per hour */
const TS_EVENT_RATE_LIMIT_COL      = 'tsRateLimits';
const TS_EVENT_RATE_WINDOW_SECONDS = 3600;           /* 1-hour sliding window */
const TS_EVENT_RATE_AUTH           = 50;             /* 50 events/hr for authenticated users */
const TS_EVENT_RATE_GUEST          = 20;             /* 20 events/hr for unauthenticated (per IP) */

/**
 * Sliding-window rate limiter for analytics events.
 * Returns true if the request should be rejected (over limit).
 */
async function _tsEventRateLimited(db, uid, rawToken) {
  const key     = uid ? `uid_${uid}` : `ip_${(rawToken || '').slice(0, 40)}`;
  const limit   = uid ? TS_EVENT_RATE_AUTH : TS_EVENT_RATE_GUEST;
  const nowSec  = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - TS_EVENT_RATE_WINDOW_SECONDS;
  const ref     = db.collection(TS_EVENT_RATE_LIMIT_COL).doc(key);

  try {
    let tooMany = false;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : { events: [] };
      /* Prune timestamps outside the current window */
      const events = (data.events || []).filter(t => t > windowStart);
      tooMany = events.length >= limit;
      if (!tooMany) {
        events.push(nowSec);
        tx.set(ref, { events, updatedAt: nowSec }, { merge: true });
      }
    });
    return tooMany;
  } catch (_) {
    return false; /* fail open — don't block on rate-limit errors */
  }
}

/* ═══════════════════════════════════════════════════════════════════
   RECORD SEARCH EVENT — Client callable
════════════════════════════════════════════════════════════════════ */

exports.recordTypesenseSearchEvent = onCall(
  { timeoutSeconds: 10, memory: '256MiB' },
  async ({ data, auth, rawRequest }) => {
    if (!VALID_TYPES.has(data?.type)) throw new HttpsError('invalid-argument', 'Invalid event type');

    const db  = getFirestore();
    const uid = auth?.uid || null;

    /* Reject if rate limit exceeded */
    const ipToken = rawRequest?.ip;
    if (await _tsEventRateLimited(db, uid, ipToken)) {
      throw new HttpsError('resource-exhausted', 'Too many search events. Please slow down.');
    }

    const {
      type,
      query        = '',
      collection   = 'sokoni_products',
      hitCount     = 0,
      clickedId    = null,
      clickedPos   = null,
      filterBy     = null,
      sortBy       = null,
      latencyMs    = null,
      sessionId    = null,
    } = data;

    /* Validate collection against known set */
    const safeCollection = VALID_COLLECTIONS.has(collection) ? collection : 'sokoni_products';

    /* Sanitize string fields */
    const safeFilterBy = filterBy ? String(filterBy).slice(0, 200) : null;
    const safeSortBy   = sortBy   ? String(sortBy).slice(0, 100)   : null;
    const safeSessionId = sessionId ? String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : null;
    const safeClickedId = clickedId ? String(clickedId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) : null;

    await db.collection(EVENTS_COL).add({
      type,
      query:        String(query).toLowerCase().trim().slice(0, 120),
      collection:   safeCollection,
      hitCount:     Math.max(0, parseInt(hitCount, 10) || 0),
      clickedId:    safeClickedId,
      clickedPos:   clickedPos !== null ? Math.max(0, parseInt(clickedPos, 10)) : null,
      filterBy:     safeFilterBy,
      sortBy:       safeSortBy,
      latencyMs:    latencyMs !== null ? Math.max(0, parseInt(latencyMs, 10)) : null,
      sessionId:    safeSessionId,
      uid,
      ts:           FieldValue.serverTimestamp(),
    });

    return { ok: true };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   REAL-TIME AGGREGATOR — Fires on each new event doc
════════════════════════════════════════════════════════════════════ */

exports.tsEventAggregator = onDocumentCreated(
  { document: `${EVENTS_COL}/{eventId}`, region: 'us-central1' },
  async event => {
    const data = event.data?.data();
    if (!data) return;

    const db      = getFirestore();
    const dateKey = _dateKey();
    const query   = data.query || '';

    /* Daily summary counter */
    const dailyRef = db.collection(ANALYTICS_COL).doc(`daily_${dateKey}`);
    await dailyRef.set({
      date:        dateKey,
      totalSearches:  data.type === 'search'   ? FieldValue.increment(1) : FieldValue.increment(0),
      totalClicks:    data.type === 'click'     ? FieldValue.increment(1) : FieldValue.increment(0),
      totalConversions: data.type === 'conversion' ? FieldValue.increment(1) : FieldValue.increment(0),
      zeroResults:    (data.type === 'search' && data.hitCount === 0) ? FieldValue.increment(1) : FieldValue.increment(0),
      updatedAt:   FieldValue.serverTimestamp(),
    }, { merge: true });

    /* Query stats (per unique query) */
    if (data.type === 'search' && query) {
      const qKey = query.slice(0, 80).replace(/\//g, '_');
      const qRef = db.collection(QUERY_STATS_COL).doc(qKey);
      await qRef.set({
        query,
        count:       FieldValue.increment(1),
        zeroHits:    data.hitCount === 0 ? FieldValue.increment(1) : FieldValue.increment(0),
        lastSearchedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      /* Zero-results tracking */
      if (data.hitCount === 0) {
        const zRef = db.collection(ZERO_RESULTS_COL).doc(qKey);
        await zRef.set({
          query,
          count: FieldValue.increment(1),
          lastSeenAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    /* Click stats */
    if (data.type === 'click' && data.clickedId) {
      const cRef = db.collection(CLICK_STATS_COL).doc(data.clickedId);
      await cRef.set({
        id:          data.clickedId,
        collection:  data.collection || 'sokoni_products',
        clicks:      FieldValue.increment(1),
        avgPosition: data.clickedPos || 0,
        lastClickedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    /* Filter stats */
    if (data.type === 'search' && data.filterBy) {
      const fKey = data.filterBy.slice(0, 80).replace(/\//g, '_');
      const fRef = db.collection(FILTER_STATS_COL).doc(fKey);
      await fRef.set({
        filter: data.filterBy,
        count: FieldValue.increment(1),
        lastUsedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    /* Latency tracking */
    if (data.type === 'search' && data.latencyMs !== null) {
      await dailyRef.set({
        totalLatencyMs: FieldValue.increment(data.latencyMs),
        latencySamples: FieldValue.increment(1),
      }, { merge: true });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   DAILY AGGREGATION — 02:30 UTC
════════════════════════════════════════════════════════════════════ */

exports.aggregateTypesenseAnalytics = onSchedule(
  { schedule: 'every day 02:30', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const db      = getFirestore();
    const dateKey = _dateKey();

    /* Top 100 queries by count */
    const topQueriesSnap = await db.collection(QUERY_STATS_COL)
      .orderBy('count', 'desc').limit(100).get();
    const topQueries = topQueriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Top 50 zero-result queries */
    const zeroSnap = await db.collection(ZERO_RESULTS_COL)
      .orderBy('count', 'desc').limit(50).get();
    const zeroResults = zeroSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Top 100 clicked items */
    const clickSnap = await db.collection(CLICK_STATS_COL)
      .orderBy('clicks', 'desc').limit(100).get();
    const topClicked = clickSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Top 50 filters */
    const filterSnap = await db.collection(FILTER_STATS_COL)
      .orderBy('count', 'desc').limit(50).get();
    const topFilters = filterSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Today's daily summary */
    const dailyDoc = await db.collection(ANALYTICS_COL).doc(`daily_${dateKey}`).get();
    const daily    = dailyDoc.exists ? dailyDoc.data() : {};
    const avgLatency = daily.latencySamples
      ? Math.round(daily.totalLatencyMs / daily.latencySamples)
      : null;

    /* Write summary */
    const summary = {
      date:        dateKey,
      topQueries:  topQueries.slice(0, 50),
      zeroResults: zeroResults.slice(0, 20),
      topClicked:  topClicked.slice(0, 30),
      topFilters:  topFilters.slice(0, 20),
      daily: { ...daily, avgLatencyMs: avgLatency },
      generatedAt: FieldValue.serverTimestamp(),
    };

    /* Write to `latest` + date-specific report */
    const batch = db.batch();
    batch.set(db.collection(ANALYTICS_COL).doc('latest'),              summary);
    batch.set(db.collection(ANALYTICS_COL).doc(`report_${dateKey}`),   summary);
    await batch.commit();

    /* Generate trending */
    await _generateTrending(db, topClicked, topQueries);

    console.log(`[Typesense Analytics] Aggregated: ${topQueries.length} queries, ${zeroResults.length} zero-results.`);
  }
);

/* ── Generate trending items ────────────────────────────────────── */

async function _generateTrending(db, topClicked, topQueries) {
  const batch = db.batch();

  /* Trending products (top 30 clicked product IDs) */
  const productTrends = topClicked
    .filter(c => c.collection === 'sokoni_products')
    .slice(0, 30);

  productTrends.forEach((item, i) => {
    const ref = db.collection(TRENDING_COL).doc(`ts_product_${item.id}`);
    batch.set(ref, {
      type:  'product',
      docId: item.id,
      rank:  i + 1,
      clicks: item.clicks,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  /* Trending search queries (top 20) */
  topQueries.slice(0, 20).forEach((q, i) => {
    const ref = db.collection(TRENDING_COL).doc(`ts_query_${q.id}`);
    batch.set(ref, {
      type:  'query',
      query: q.query,
      rank:  i + 1,
      count: q.count,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();
}

/* ═══════════════════════════════════════════════════════════════════
   GET ANALYTICS — Admin callable
════════════════════════════════════════════════════════════════════ */

exports.getTypesenseAnalytics = onCall(
  { timeoutSeconds: 30 },
  async ({ auth }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const db  = getFirestore();
    const doc = await db.collection(ANALYTICS_COL).doc('latest').get();
    if (!doc.exists) return { empty: true };
    return doc.data();
  }
);

/* ═══════════════════════════════════════════════════════════════════
   AUTOCOMPLETE SUGGESTIONS — Public callable
════════════════════════════════════════════════════════════════════ */

exports.getTsAutocompleteSuggestions = onCall(
  { timeoutSeconds: 5 },
  async ({ data }) => {
    const prefix = String(data?.prefix || '').toLowerCase().trim().slice(0, 40);
    if (!prefix) return { suggestions: [] };

    const db   = getFirestore();
    const snap = await db.collection(QUERY_STATS_COL)
      .orderBy('count', 'desc')
      .limit(200)
      .get();

    const suggestions = snap.docs
      .map(d => d.data())
      .filter(d => d.query?.startsWith(prefix))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map(d => ({ query: d.query, count: d.count }));

    return { suggestions };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   CLEANUP — Weekly, purge raw events older than 90 days
════════════════════════════════════════════════════════════════════ */

exports.typesenseAnalyticsCleanup = onSchedule(
  { schedule: 'every sunday 03:30', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db      = getFirestore();
    const cutoff  = new Date(Date.now() - 90 * 86_400_000);

    let deleted = 0;
    for (;;) {
      const snap = await db.collection(EVENTS_COL)
        .where('ts', '<', cutoff)
        .limit(500).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
    }
    console.log(`[Typesense Analytics Cleanup] Deleted ${deleted} raw events.`);
  }
);

/* ── Utility ─────────────────────────────────────────────────────── */

function _dateKey() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}
