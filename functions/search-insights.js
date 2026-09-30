/* ============================================================
   SOKONI Search Insights Engine  v1.0

   Exports:
     getSearchInsights   onCall (admin) — no-result queries, top terms, trends
     getZeroResultTerms  onCall (admin) — just the no-result list for quick action
     recordSearchQuery   onCall (public) — lightweight search log (non-Algolia)

   Reads from:
     searchAnalytics/{eventId}   (written by algolia-analytics.js)
     searchQueryLog/{logId}      (written by recordSearchQuery)
============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const CF_PUB  = { region: "us-central1", memory: "128MiB", timeoutSeconds: 20, maxInstances: 200 };
const CF_ADM  = { region: "us-central1", memory: "512MiB", timeoutSeconds: 120 };

function _isAdmin(auth) {
  return auth?.token?.admin === true || auth?.token?.role === "admin" || auth?.token?.role === "superAdmin";
}

/* ════════════════════════════════════════════════════════════
   recordSearchQuery
   Public, lightweight — logs anonymous search signals that
   supplement Algolia's own analytics. Called by the frontend
   when Algolia isn't available or for extra context.
════════════════════════════════════════════════════════════ */
exports.recordSearchQuery = onCall(CF_PUB, async (req) => {
  const { query, resultCount, filters, source } = req.data || {};
  const q = (query || "").trim().slice(0, 200).toLowerCase();
  if (!q) return { ok: false };

  const count   = parseInt(resultCount) ?? -1;
  const today   = new Date().toISOString().slice(0, 10);
  const noResult = count === 0;

  /* Aggregate into daily searchQueryLog document */
  const logRef = db.collection("searchQueryLog").doc(`${today}_${q.slice(0, 50).replace(/\W+/g, "_")}`);
  await logRef.set({
    query:       q,
    date:        today,
    count:       FV.increment(1),
    resultCount: count,
    noResult,
    filters:     filters || null,
    source:      source || "web",
    updatedAt:   FV.serverTimestamp(),
  }, { merge: true });

  return { ok: true };
});

/* ════════════════════════════════════════════════════════════
   getSearchInsights
   Admin-callable report covering:
     - Top searched terms (by frequency)
     - No-result queries (sorted by frequency)
     - High-converting searches (from Algolia analytics)
     - Common filters used
     - Search volume trend (last 30 days)
════════════════════════════════════════════════════════════ */
exports.getSearchInsights = onCall(CF_ADM, async (req) => {
  if (!_isAdmin(req.auth)) throw new HttpsError("permission-denied", "Admin only");
  const days = Math.min(parseInt(req.data?.days) || 30, 90);
  const cutoff = new Date(Date.now() - days * 864e5);

  /* 1. Pull from algolia searchAnalytics events */
  const [algoliaSnap, logSnap] = await Promise.all([
    db.collection("searchAnalytics")
      .where("ts", ">=", cutoff).limit(5000).get(),
    db.collection("searchQueryLog")
      .where("updatedAt", ">=", cutoff).limit(2000).get(),
  ]);

  /* Aggregate Algolia events */
  const queryFreq    = {};
  const queryConvert = {};
  const filterFreq   = {};
  let totalSearches  = 0;
  let totalClicks    = 0;
  let totalConverts  = 0;
  let noResultCount  = 0;

  algoliaSnap.docs.forEach(d => {
    const ev = d.data();
    const q  = (ev.query || "").trim().toLowerCase();
    if (!q) return;

    if (ev.type === "search") {
      totalSearches++;
      queryFreq[q] = (queryFreq[q] || 0) + 1;
      if (ev.resultCount === 0) noResultCount++;
    }
    if (ev.type === "click")      totalClicks++;
    if (ev.type === "conversion") {
      totalConverts++;
      queryConvert[q] = (queryConvert[q] || 0) + 1;
    }
    if (ev.type === "no_results") {
      queryFreq[q] = (queryFreq[q] || 0) + 1;
    }
    if (ev.type === "filter_use" && ev.filter) {
      filterFreq[ev.filter] = (filterFreq[ev.filter] || 0) + 1;
    }
  });

  /* Merge searchQueryLog */
  const noResultMap = {};
  logSnap.docs.forEach(d => {
    const ev = d.data();
    if (!ev.query) return;
    queryFreq[ev.query] = (queryFreq[ev.query] || 0) + (ev.count || 1);
    if (ev.noResult) noResultMap[ev.query] = (noResultMap[ev.query] || 0) + (ev.count || 1);
  });

  /* Build sorted lists */
  const topQueries = Object.entries(queryFreq)
    .sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([query, count]) => ({ query, count, converts: queryConvert[query] || 0 }));

  const noResultTerms = Object.entries(noResultMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([query, count]) => ({ query, count, suggestion: _synonymSuggestion(query) }));

  const topFilters = Object.entries(filterFreq)
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([filter, count]) => ({ filter, count }));

  const topConverting = Object.entries(queryConvert)
    .filter(([q]) => queryFreq[q] >= 5)
    .sort((a, b) => b[1] / (queryFreq[b[0]] || 1) - a[1] / (queryFreq[a[0]] || 1))
    .slice(0, 10)
    .map(([query, converts]) => ({
      query, converts,
      searches: queryFreq[query] || 0,
      conversionRate: Math.round((converts / (queryFreq[query] || 1)) * 100),
    }));

  /* Day-by-day search volume from logSnap */
  const dailyVolume = {};
  logSnap.docs.forEach(d => {
    const ev = d.data();
    if (ev.date) dailyVolume[ev.date] = (dailyVolume[ev.date] || 0) + (ev.count || 1);
  });
  const volumeTrend = Object.entries(dailyVolume)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  const ctr = totalSearches > 0 ? Math.round((totalClicks / totalSearches) * 100) : 0;
  const convRate = totalSearches > 0 ? Math.round((totalConverts / totalSearches) * 100) : 0;

  return {
    periodDays: days,
    summary: {
      totalSearches,
      totalClicks,
      totalConversions: totalConverts,
      noResultSearches: noResultCount,
      clickThroughRate: ctr,
      conversionRate:   convRate,
      uniqueQueries:    Object.keys(queryFreq).length,
    },
    topQueries,
    noResultTerms,
    topConverting,
    topFilters,
    volumeTrend,
    recommendations: _buildSearchRecs(noResultTerms, topQueries, convRate),
  };
});

/* ════════════════════════════════════════════════════════════
   getZeroResultTerms
   Quick lookup for merchandising — just the no-result list.
════════════════════════════════════════════════════════════ */
exports.getZeroResultTerms = onCall({ region: "us-central1" }, async (req) => {
  if (!_isAdmin(req.auth)) throw new HttpsError("permission-denied", "Admin only");
  const snap = await db.collection("searchQueryLog")
    .where("noResult", "==", true).orderBy("count", "desc").limit(100).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data(), updatedAt: d.data().updatedAt?.toMillis?.() || null }));
});

/* ── helpers ── */
function _synonymSuggestion(query) {
  const map = {
    "phone": "mobile, smartphone, handset",
    "tv": "television, screen, monitor",
    "sofa": "couch, settee, seat",
    "fridge": "refrigerator, cooler",
    "car": "vehicle, automobile",
    "laptop": "computer, notebook",
    "dress": "clothing, outfit, wear",
    "shoes": "footwear, boots, sneakers",
  };
  const lower = query.toLowerCase();
  for (const [key, val] of Object.entries(map)) {
    if (lower.includes(key)) return `Try synonyms: ${val}`;
  }
  return "Consider adding this as a search synonym or curated result";
}

function _buildSearchRecs(noResultTerms, topQueries, convRate) {
  const recs = [];
  if (noResultTerms.length > 0)
    recs.push({ priority: "high",
      action: `Add ${noResultTerms.slice(0,3).map(t=>`"${t.query}"`).join(", ")} as search synonyms or seed products in those categories`,
      category: "no_results" });
  if (convRate < 5 && topQueries.length > 0)
    recs.push({ priority: "high",
      action: "Search conversion rate is low — review top query result quality and ensure product titles include common search terms",
      category: "conversion" });
  if (topQueries.length > 0)
    recs.push({ priority: "medium",
      action: `Top searched: "${topQueries[0].query}" — ensure top listings for this term are high quality`,
      category: "relevance" });
  return recs;
}
