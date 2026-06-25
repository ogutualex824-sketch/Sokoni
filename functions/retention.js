/* ============================================================
   SOKONI Retention Engine  v1.0

   Exports:
     recordRecentlyViewed  onCall (public)      — deduped, per-user
     saveSearch            onCall (auth)         — save a search query
     deleteSavedSearch     onCall (auth)         — remove a saved search
     createPriceAlert      onCall (auth)         — alert when price drops to target
     deletePriceAlert      onCall (auth)         — cancel a price alert
     triggerPriceAlerts    onSchedule (daily)    — check prices, email matches
     getRetentionData      onCall (auth)         — recently viewed + saved searches + alerts

   Collections:
     recentlyViewed/{uid}/items/{productId}
     savedSearches/{uid}/searches/{searchId}
     priceAlerts/{alertId}
============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule }         = require("firebase-functions/v2/scheduler");
const { defineSecret }       = require("firebase-functions/params");
const admin  = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db  = admin.firestore();
const FV  = admin.firestore.FieldValue;

const SENDGRID_API_KEY = defineSecret("SENDGRID_API_KEY");
const CF_PUB  = { region: "us-central1", memory: "128MiB", timeoutSeconds: 20 };
const CF_AUTH = { region: "us-central1", memory: "128MiB", timeoutSeconds: 20 };
const CF_SCHED = { region: "us-central1", memory: "256MiB", timeoutSeconds: 120,
                   schedule: "0 7 * * *", secrets: [SENDGRID_API_KEY] };

/* ────────────────────────────────────────────────────────────
   recordRecentlyViewed
   Stores the last 20 viewed products per user (in Firestore
   for logged-in users). Anonymous users rely on localStorage.
──────────────────────────────────────────────────────────── */
exports.recordRecentlyViewed = onCall({ ...CF_PUB, maxInstances: 200 }, async (req) => {
  if (!req.auth) return { ok: false }; // silently skip — frontend uses localStorage

  const uid = req.auth.uid;
  const { productId, name, price, image, category } = req.data || {};
  if (!productId || typeof productId !== "string" || productId.length > 128) return { ok: false };

  const ref = db.collection("recentlyViewed").doc(uid).collection("items").doc(productId);
  await ref.set({
    productId,
    name:     (name     || "").slice(0, 120),
    price:    parseFloat(price) || 0,
    image:    (image    || "").slice(0, 500),
    category: (category || "").slice(0, 60),
    viewedAt: FV.serverTimestamp(),
  }, { merge: true });

  /* Prune to 20 most recent */
  const snap = await db.collection("recentlyViewed").doc(uid).collection("items")
    .orderBy("viewedAt", "desc").offset(20).limit(50).get();
  if (!snap.empty) {
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  return { ok: true };
});

/* ────────────────────────────────────────────────────────────
   saveSearch
──────────────────────────────────────────────────────────── */
exports.saveSearch = onCall(CF_AUTH, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const uid = req.auth.uid;
  const { query, filters } = req.data || {};

  const q = (query || "").trim().slice(0, 200);
  if (!q) throw new HttpsError("invalid-argument", "Query required");

  /* Check for duplicate */
  const existing = await db.collection("savedSearches").doc(uid).collection("searches")
    .where("query", "==", q).limit(1).get();
  if (!existing.empty) return { id: existing.docs[0].id, duplicate: true };

  /* Limit: 20 saved searches per user */
  const countSnap = await db.collection("savedSearches").doc(uid).collection("searches").count().get();
  if (countSnap.data().count >= 20) throw new HttpsError("resource-exhausted", "Max 20 saved searches");

  const ref = await db.collection("savedSearches").doc(uid).collection("searches").add({
    query:   q,
    filters: filters || null,
    savedAt: FV.serverTimestamp(),
    lastRunAt: null,
    resultCount: null,
  });
  return { id: ref.id };
});

/* ────────────────────────────────────────────────────────────
   deleteSavedSearch
──────────────────────────────────────────────────────────── */
exports.deleteSavedSearch = onCall(CF_AUTH, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const uid = req.auth.uid;
  const { id } = req.data || {};
  if (!id) throw new HttpsError("invalid-argument", "id required");

  await db.collection("savedSearches").doc(uid).collection("searches").doc(id).delete();
  return { ok: true };
});

/* ────────────────────────────────────────────────────────────
   createPriceAlert
   Alerts the user via email when a product's price drops to
   or below their target price.
──────────────────────────────────────────────────────────── */
exports.createPriceAlert = onCall(CF_AUTH, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const uid   = req.auth.uid;
  const email = req.auth.token?.email || null;
  const { productId, productName, currentPrice, targetPrice } = req.data || {};

  if (!productId) throw new HttpsError("invalid-argument", "productId required");
  const target  = parseFloat(targetPrice);
  const current = parseFloat(currentPrice);
  if (!target || target <= 0) throw new HttpsError("invalid-argument", "targetPrice must be positive");
  if (target >= current) throw new HttpsError("invalid-argument", "targetPrice must be below current price");

  /* One alert per user per product */
  const existing = await db.collection("priceAlerts")
    .where("uid", "==", uid).where("productId", "==", productId).where("status", "==", "active").limit(1).get();
  if (!existing.empty) {
    await existing.docs[0].ref.update({ targetPrice: target, updatedAt: FV.serverTimestamp() });
    return { id: existing.docs[0].id, updated: true };
  }

  const ref = await db.collection("priceAlerts").add({
    uid,
    email:        email || null,
    productId,
    productName:  (productName || "").slice(0, 120),
    currentPrice: current,
    targetPrice:  target,
    status:       "active",
    createdAt:    FV.serverTimestamp(),
    updatedAt:    FV.serverTimestamp(),
    triggeredAt:  null,
  });
  return { id: ref.id };
});

/* ────────────────────────────────────────────────────────────
   deletePriceAlert
──────────────────────────────────────────────────────────── */
exports.deletePriceAlert = onCall(CF_AUTH, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const uid = req.auth.uid;
  const { id } = req.data || {};
  if (!id) throw new HttpsError("invalid-argument", "id required");

  const doc = await db.collection("priceAlerts").doc(id).get();
  if (!doc.exists || doc.data().uid !== uid) throw new HttpsError("not-found", "Alert not found");
  await doc.ref.update({ status: "cancelled", updatedAt: FV.serverTimestamp() });
  return { ok: true };
});

/* ────────────────────────────────────────────────────────────
   triggerPriceAlerts
   Runs daily at 10:00 EAT (07:00 UTC).
   Checks active alerts against current product prices.
   Sends email notification when target is met.
──────────────────────────────────────────────────────────── */
exports.triggerPriceAlerts = onSchedule(CF_SCHED, async () => {
  const sgKey = SENDGRID_API_KEY.value();
  if (!sgKey || sgKey.startsWith("placeholder")) return;

  /* Fetch all active alerts in batches of 500 */
  const alertsSnap = await db.collection("priceAlerts")
    .where("status", "==", "active").limit(500).get();
  if (alertsSnap.empty) return;

  /* Fetch unique product IDs */
  const productIds = [...new Set(alertsSnap.docs.map(d => d.data().productId))];
  const productDocs = await Promise.all(
    productIds.map(id => db.collection("products").doc(id).get())
  );
  const priceMap = {};
  productDocs.forEach(d => { if (d.exists) priceMap[d.id] = parseFloat(d.data().price) || 0; });

  const batch   = db.batch();
  const emails  = [];

  alertsSnap.docs.forEach(doc => {
    const alert   = doc.data();
    const current = priceMap[alert.productId];
    if (current === undefined) return;

    if (current <= alert.targetPrice) {
      batch.update(doc.ref, {
        status: "triggered",
        triggeredAt: FV.serverTimestamp(),
        triggeredPrice: current,
        updatedAt: FV.serverTimestamp(),
      });
      if (alert.email) {
        emails.push({
          to:      alert.email,
          name:    alert.productName,
          target:  alert.targetPrice,
          current,
          id:      doc.id,
        });
      }
    } else {
      /* Keep alert fresh with latest price */
      batch.update(doc.ref, { currentPrice: current, updatedAt: FV.serverTimestamp() });
    }
  });

  await batch.commit();

  /* Send email notifications */
  for (const e of emails) {
    try {
      await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${sgKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: e.to }] }],
          from: { email: "noreply@mysokoni.co.ke", name: "SOKONI" },
          subject: `Price Drop Alert: ${e.name}`,
          content: [{
            type: "text/html",
            value: `
              <p>Great news! A product on your watch list has dropped to your target price.</p>
              <table style="border-collapse:collapse;width:100%;max-width:480px">
                <tr><td style="padding:8px;font-weight:bold">Product</td><td style="padding:8px">${e.name}</td></tr>
                <tr><td style="padding:8px;font-weight:bold">Target Price</td><td style="padding:8px">KES ${e.target.toLocaleString()}</td></tr>
                <tr><td style="padding:8px;font-weight:bold;color:#10b981">Current Price</td><td style="padding:8px;color:#10b981;font-weight:bold">KES ${e.current.toLocaleString()}</td></tr>
              </table>
              <p style="margin-top:20px"><a href="https://mysokoni.co.ke/store" style="background:#5b21b6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Shop Now</a></p>
              <p style="color:#9ca3af;font-size:12px;margin-top:16px">You set this alert on mysokoni.co.ke. <a href="https://mysokoni.co.ke/profile">Manage alerts</a></p>
            `,
          }],
        }),
      });
    } catch (_) { /* non-fatal */ }
  }
});

/* ────────────────────────────────────────────────────────────
   getRetentionData
   Returns the caller's recently viewed, saved searches, and price alerts.
──────────────────────────────────────────────────────────── */
exports.getRetentionData = onCall(CF_AUTH, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  const uid = req.auth.uid;

  const [recentSnap, searchSnap, alertSnap] = await Promise.all([
    db.collection("recentlyViewed").doc(uid).collection("items")
      .orderBy("viewedAt", "desc").limit(20).get(),
    db.collection("savedSearches").doc(uid).collection("searches")
      .orderBy("savedAt", "desc").limit(20).get(),
    db.collection("priceAlerts")
      .where("uid", "==", uid).where("status", "==", "active").limit(20).get(),
  ]);

  const recentlyViewed = recentSnap.docs.map(d => ({ id: d.id, ...d.data(),
    viewedAt: d.data().viewedAt?.toMillis?.() || null }));
  const savedSearches  = searchSnap.docs.map(d => ({ id: d.id, ...d.data(),
    savedAt: d.data().savedAt?.toMillis?.() || null }));
  const priceAlerts    = alertSnap.docs.map(d => ({ id: d.id, ...d.data(),
    createdAt: d.data().createdAt?.toMillis?.() || null }));

  return { recentlyViewed, savedSearches, priceAlerts };
});
