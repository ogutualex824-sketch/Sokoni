/**
 * SOKONI Reviews & Ratings Engine v1.1
 * Cloud Functions: submitReview, getReviews, flagReview,
 *                  markReviewHelpful, adminModerateReview
 *
 * Collection layout:
 *   reviews/{reviewId}                    — top-level review docs
 *   reviews/{id}/flags/{uid}              — per-user flag records
 *   reviews/{id}/helpfulVotes/{uid}       — per-user helpful votes
 *   ratingsSummary/{targetId}             — denormalised avg+count
 *   reviewRateLimits/{uid}_{action}_{day} — daily rate-limit counters
 *
 * targetId: the BARE canonical entity id — a product id, a seller/business id.
 *
 *   This header used to document the format as "{type}_{entityId}" (e.g.
 *   "product_abc"). Nothing implements that, and it is a drift trap: submitReview
 *   stores `targetId` verbatim and keys ratingsSummary/{targetId} with it, while
 *   the live callers pass a bare id — business.html submits and reads
 *   `targetId: BIZ_ID`, and the Shop grid hydrates `ratingsSummary/{productId}`.
 *   Anyone following the old comment would write "product_abc", and their rating
 *   would be stored under a key no surface ever reads, so it would silently never
 *   appear. `targetType` carries the type; the id carries identity.
 *
 *   NEVER a product or business NAME. Names are not identity: they are editable,
 *   non-unique, and would re-point a review target the moment a merchant renames.
 *
 * Security hardening v1.1:
 *   - Per-user daily rate limits on submit/flag/helpful
 *   - Account ban check on submit
 *   - Minimum account age (1h) before reviewing
 *   - Zero-trust input validation on all public endpoints
 */

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin                  = require("firebase-admin");

// ── helpers ──────────────────────────────────────────────────────────────────
function _db() { return admin.firestore(); }

/** Strip HTML tags and trim for safe storage */
function _sanitize(str, maxLen = 2000) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").trim().slice(0, maxLen);
}

function _requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  return req.auth.uid;
}

function _isAdmin(req) {
  return !!(req.auth?.token?.admin || req.auth?.token?.superAdmin);
}

/**
 * Firestore-backed daily rate limiter for reviews actions.
 * Key: `{uid}_{action}_{YYYY-MM-DD}` — auto-expires by date.
 */
async function _checkReviewRateLimit(uid, action, limit) {
  const db  = _db();
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection("reviewRateLimits").doc(`${uid}_${action}_${day}`);
  let allowed = false;
  await db.runTransaction(async (tx) => {
    const doc   = await tx.get(ref);
    const count = doc.exists ? (doc.data().count || 0) : 0;
    if (count >= limit) return; // allowed stays false
    tx.set(ref, {
      uid, action, day,
      count:     count + 1,
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 86400000 * 2)),
    }, { merge: true });
    allowed = true;
  });
  if (!allowed) throw new HttpsError("resource-exhausted", `Daily limit reached for ${action}. Try again tomorrow.`);
}

/** Check user is not banned and account is old enough */
async function _assertReviewEligible(uid) {
  const db      = _db();
  const userDoc = await db.collection("users").doc(uid).get().catch(() => null);
  if (!userDoc || !userDoc.exists) throw new HttpsError("not-found", "User profile not found.");
  const data = userDoc.data();
  if (data.isBanned || data.status === "banned" || data.status === "suspended") {
    throw new HttpsError("permission-denied", "Account restricted. Contact support.");
  }
  // Minimum 1-hour account age to prevent throwaway review accounts
  const created = data.createdAt?.toDate?.() || data.created ? new Date(data.created) : null;
  if (created && (Date.now() - created.getTime()) < 3600000) {
    throw new HttpsError("permission-denied", "Account too new to submit reviews.");
  }
}

/** Recalculate and update ratingsSummary for a target */
async function _recalcSummary(targetId) {
  const db = _db();
  const snap = await db.collection("reviews")
    .where("targetId", "==", targetId)
    .where("status", "==", "approved")
    .get();

  const count = snap.size;
  let sum = 0;
  snap.docs.forEach(d => { sum += (d.data().rating || 0); });
  const avg = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;

  await db.collection("ratingsSummary").doc(targetId).set({
    targetId,
    avg,
    count,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { avg, count };
}

/* ══ THE REVIEW AUTHORITY (owner, 2026-10-01: "all reviews approved in AdminOS before they are public") ══════════
   Live provenance (2026-10-01 audit): submitReview / getReviews / flagReview / markReviewHelpful /
   adminModerateReview all serve the 09-09 archive that equals 76436b1 (0 files differ). Callers: sokoni-reviews.js
   (product page) and business.html (seller). Collection: reviews (+ ratingsSummary). Found and fixed here:
     · autoApprove = true — every review was public the moment it was written;
     · purchase was never verified — no caller sends orderId, so the check never ran;
     · product.html keys the widget "product_<id>" while product.js reads the bare id — a split rating key;
     · adminModerateReview had no state machine, no history and no self-interest check.
   The browser may REQUEST a review. The server decides identity, eligibility, target, duplicate and status. */
const REVIEW_TYPES = Object.freeze(['product', 'seller']);            /* other domains review through their own stores */
/** "product_abc" → "abc" for a product target (the live widget's prefix); never a name; the BARE id is identity. */
function _canonTarget(targetType, targetId) {
  let id = String(targetId || '').trim();
  const pre = targetType + '_';
  if (id.indexOf(pre) === 0) id = id.slice(pre.length);
  return id;
}
/** Server-side eligibility: the reviewer must hold a PAID order, delivered or completed, containing the product
 *  (product review) or sold by the seller (seller review). Bounded reads; client-supplied orderId is not authority. */
async function _eligibleOrder(db, uid, targetType, targetId) {
  const DONE = ['delivered', 'completed'];
  const seen = new Map();
  for (const f of ['buyerUid', 'uid']) {
    const snap = await db.collection('orders').where(f, '==', uid).limit(100).get().catch(() => null);
    (snap ? snap.docs : []).forEach((d) => seen.set(d.id, d.data() || {}));
  }
  for (const [id, o] of seen) {
    if (!DONE.includes(String(o.status || '')) || o.paymentVerified !== true) continue;
    if (targetType === 'seller' && (String(o.sellerUid || '') === targetId || String(o.shopId || '') === targetId)) return id;
    if (targetType === 'product' && Array.isArray(o.items) && o.items.some((it) => it && String(it.productId || it.id || '') === targetId)) return id;
  }
  return null;
}

// ── submitReview ──────────────────────────────────────────────────────────────
exports.submitReview = onCall({ region: "us-central1" }, async (req) => {
  const uid = _requireAuth(req);

  // Zero-trust input validation
  const { targetName, rating, title, body, images } = req.data || {};
  const targetType = String((req.data || {}).targetType || '');
  if (!REVIEW_TYPES.includes(targetType)) {
    throw new HttpsError("invalid-argument", "Reviews here are for products and sellers. Rate a service from your booking.", { reason: "UNSUPPORTED_TARGET" });
  }
  const targetId = _canonTarget(targetType, (req.data || {}).targetId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(targetId)) throw new HttpsError("invalid-argument", "targetId required.");
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new HttpsError("invalid-argument", "Rating must be 1-5.");
  }
  if (body && typeof body === "string" && body.trim().length < 10) {
    throw new HttpsError("invalid-argument", "Review body must be at least 10 characters.");
  }

  // Security checks — rate limit (3/day) + ban + account age
  await Promise.all([
    _checkReviewRateLimit(uid, "submit", 3),
    _assertReviewEligible(uid),
  ]);

  const db = _db();

  // One review per user per target (legacy random-id docs included)
  const existing = await db.collection("reviews")
    .where("targetId", "==", targetId)
    .where("authorUid", "==", uid)
    .limit(1).get();
  if (!existing.empty) throw new HttpsError("already-exists", "You have already reviewed this.", { reason: "DUPLICATE" });

  // ELIGIBILITY — the server finds the qualifying order itself (a client orderId is never the authority)
  const eligibleOrderId = await _eligibleOrder(db, uid, targetType, targetId);
  if (!eligibleOrderId) {
    throw new HttpsError("failed-precondition", "You can review this after an order for it has been delivered.", { reason: "NOT_ELIGIBLE" });
  }

  const cleanTitle = _sanitize(title, 120);
  const cleanBody  = _sanitize(body, 2000);
  const safeImages = Array.isArray(images)
    ? images.filter(u => typeof u === "string" && u.startsWith("https://")).slice(0, 5)
    : [];

  /* PENDING ALWAYS — published only by adminModerateReview 'approve'. Deterministic id → create() is the
     one-per-person-per-target claim even under a double tap. */
  const reviewRef = db.collection("reviews").doc(uid + "_" + targetType + "_" + targetId);
  await reviewRef.create({
    targetId,
    targetType,
    targetName: _sanitize(targetName, 120),
    authorUid:  uid,
    rating,
    title:   cleanTitle,
    body:    cleanBody,
    images:  safeImages,
    orderId: eligibleOrderId,
    helpful: 0,
    flags:   0,
    status:  "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("reviewModerationLog").add({ reviewId: reviewRef.id, from: null, to: "pending", action: "submit",
    actorUid: uid, targetId, targetType, at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  return { reviewId: reviewRef.id, status: "pending" };
});

/* ══ UNBOXING — server-side approval (owner 2026-10-01/03: approved in AdminOS before public; approve / decline /
   archive / delete) ═════════════════════════════════════════════════════════════════════════════════════════════
   The live Unboxing Wall wrote unboxingReviews straight from the browser with no moderation. Now the browser asks;
   this callable decides: the order is the CALLER's, paid, delivered/completed; the product is resolved from the
   order's own lines (a client productId must be one of them); photos must be the caller's own Storage uploads
   (unboxing/{uid}/…); one post per buyer per product; ALWAYS pending. Moderation is adminModerateReview kind
   'unboxing' (the same state machine + history). The wall reads approved posts only (rules R0). */
const UNBOX_MEDIA_RE = (uid) => new RegExp('^https://firebasestorage\\.googleapis\\.com/v0/b/[^/]+/o/unboxing%2F' + uid.replace(/[^A-Za-z0-9_-]/g, '') + '%2F[^?#]+(\\?|$)');
exports.submitUnboxing = onCall({ region: "us-central1" }, async (req) => {
  const uid = _requireAuth(req);
  const d = req.data || {};
  const orderId = String(d.orderId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) throw new HttpsError("invalid-argument", "Choose the order you are unboxing.", { reason: "ORDER_REQUIRED" });
  const rating = Number(d.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpsError("invalid-argument", "Rating must be 1-5.");
  const comment = _sanitize(d.comment, 2000);
  if (comment.length < 10) throw new HttpsError("invalid-argument", "Tell buyers a little more (at least 10 characters).");
  const re = UNBOX_MEDIA_RE(uid);
  const imgs = Array.isArray(d.images) ? d.images : [];
  if (imgs.length > 4 || imgs.some((u) => typeof u !== 'string' || !re.test(u))) {
    throw new HttpsError("invalid-argument", "Photos must be your own uploads (up to 4).", { reason: "BAD_MEDIA" });
  }
  await Promise.all([_checkReviewRateLimit(uid, "unboxing", 3), _assertReviewEligible(uid)]);
  const db = _db();
  const oSnap = await db.collection("orders").doc(orderId).get();
  const o = oSnap.exists ? (oSnap.data() || {}) : null;
  const buyer = o && (o.buyerUid || o.uid || o.userId);
  if (!o || buyer !== uid) throw new HttpsError("permission-denied", "That order is not yours.", { reason: "NOT_YOUR_ORDER" });
  if (o.paymentVerified !== true || !["delivered", "completed"].includes(String(o.status || ""))) {
    throw new HttpsError("failed-precondition", "You can share an unboxing once the order has been delivered.", { reason: "NOT_ELIGIBLE" });
  }
  const lines = Array.isArray(o.items) ? o.items : [];
  const want = d.productId ? String(d.productId) : null;
  const line = want ? lines.find((it) => String((it && (it.productId || it.id)) || '') === want) : lines[0];
  if (!line) throw new HttpsError("failed-precondition", "That product is not in this order.", { reason: "PRODUCT_NOT_IN_ORDER" });
  const productId = String(line.productId || line.id || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(productId)) throw new HttpsError("failed-precondition", "That order line has no product.");
  const pSnap = await db.collection("products").doc(productId).get().catch(() => null);
  const prod = pSnap && pSnap.exists ? (pSnap.data() || {}) : {};
  const ref = db.collection("unboxingReviews").doc(uid + "_" + productId);
  try {
    await ref.create({
      uid, orderId, productId, rating, comment, images: imgs,
      product: _sanitize(prod.name || line.name || '', 120), sellerUid: prod.sellerUid || o.sellerUid || null,
      category: _sanitize(d.category || prod.category || '', 40), verifiedPurchase: true,
      status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) throw new HttpsError("already-exists", "You have already shared an unboxing for this product.", { reason: "DUPLICATE" });
    throw e;
  }
  await db.collection("reviewModerationLog").add({ reviewId: ref.id, kind: "unboxing", from: null, to: "pending", action: "submit",
    actorUid: uid, targetId: productId, targetType: "product", at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  return { id: ref.id, status: "pending" };
});

exports._reviewAuthority = { REVIEW_TYPES, _canonTarget, _eligibleOrder, UNBOX_MEDIA_RE };

// ── getReviews ────────────────────────────────────────────────────────────────
exports.getReviews = onCall({ region: "us-central1" }, async (req) => {
  const { sort = "recent", limit: lim = 20, startAfter } = req.data || {};
  /* the same canonical key the writer uses: the live product widget asks for "product_<id>" */
  const rawTarget = String((req.data || {}).targetId || "");
  const targetId = rawTarget.replace(/^(product|seller)_/, "");
  if (!targetId) throw new HttpsError("invalid-argument", "targetId required.");

  const safeLimit = Math.min(50, Math.max(1, Number(lim) || 20));
  const db = _db();

  let q = db.collection("reviews")
    .where("targetId", "==", targetId)
    .where("status", "==", "approved");

  if (sort === "highest")  q = q.orderBy("rating", "desc").orderBy("createdAt", "desc");
  else if (sort === "lowest")  q = q.orderBy("rating", "asc").orderBy("createdAt", "desc");
  else if (sort === "helpful") q = q.orderBy("helpful", "desc").orderBy("createdAt", "desc");
  else                          q = q.orderBy("createdAt", "desc");

  if (startAfter) {
    const cursorDoc = await db.collection("reviews").doc(startAfter).get();
    if (cursorDoc.exists) q = q.startAfter(cursorDoc);
  }

  const snap = await q.limit(safeLimit).get();

  // Fetch summary
  const summaryDoc = await db.collection("ratingsSummary").doc(targetId).get();
  const summary    = summaryDoc.exists ? summaryDoc.data() : { avg: 0, count: 0 };

  const reviews = snap.docs.map(d => {
    const data = d.data();
    return {
      id:         d.id,
      rating:     data.rating,
      title:      data.title,
      body:       data.body,
      images:     data.images || [],
      helpful:    data.helpful || 0,
      authorUid:  data.authorUid,
      createdAt:  data.createdAt?.toDate?.()?.toISOString() || null,
      targetType: data.targetType,
    };
  });

  // Fetch display names for authors (batch)
  const uids = [...new Set(reviews.map(r => r.authorUid))];
  const userDocs = await Promise.all(
    uids.map(u => db.collection("users").doc(u).get().catch(() => null))
  );
  const nameMap = {};
  userDocs.forEach((d, i) => {
    if (d && d.exists) {
      const u = d.data();
      nameMap[uids[i]] = u.displayName || u.name || "SOKONI User";
    } else {
      nameMap[uids[i]] = "SOKONI User";
    }
  });

  reviews.forEach(r => { r.authorName = nameMap[r.authorUid] || "SOKONI User"; delete r.authorUid; });

  return {
    reviews,
    summary: { avg: summary.avg || 0, count: summary.count || 0 },
    hasMore: snap.size === safeLimit,
    lastId:  snap.size > 0 ? snap.docs[snap.docs.length - 1].id : null,
  };
});

// ── flagReview ────────────────────────────────────────────────────────────────
exports.flagReview = onCall({ region: "us-central1" }, async (req) => {
  const uid = _requireAuth(req);
  const { reviewId, reason } = req.data;
  if (!reviewId || typeof reviewId !== "string") throw new HttpsError("invalid-argument", "reviewId required.");

  // Rate limit: 10 flags per user per day
  await _checkReviewRateLimit(uid, "flag", 10);

  const db = _db();
  const ref = db.collection("reviews").doc(reviewId);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError("not-found", "Review not found.");

  const flagRef = ref.collection("flags").doc(uid);
  const flagDoc = await flagRef.get();
  if (flagDoc.exists) throw new HttpsError("already-exists", "Already flagged.");

  await flagRef.set({
    uid,
    reason:    _sanitize(reason || "inappropriate", 200),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const newFlags = (doc.data().flags || 0) + 1;
  const update   = { flags: newFlags, updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  // Auto-hide if 5+ flags — awaits manual admin review
  if (newFlags >= 5) update.status = "flagged";
  await ref.update(update);

  return { flagged: true };
});

// ── markReviewHelpful ─────────────────────────────────────────────────────────
exports.markReviewHelpful = onCall({ region: "us-central1" }, async (req) => {
  const uid = _requireAuth(req);
  const { reviewId } = req.data;
  if (!reviewId || typeof reviewId !== "string") throw new HttpsError("invalid-argument", "reviewId required.");

  // Rate limit: 50 helpful votes per user per day
  await _checkReviewRateLimit(uid, "helpful", 50);

  const db = _db();
  const ref    = db.collection("reviews").doc(reviewId);
  const voteRef = ref.collection("helpfulVotes").doc(uid);

  let toggled = false;
  await db.runTransaction(async (tx) => {
    const [reviewDoc, voteDoc] = await Promise.all([tx.get(ref), tx.get(voteRef)]);
    if (!reviewDoc.exists) throw new HttpsError("not-found", "Review not found.");

    const current = reviewDoc.data().helpful || 0;
    if (voteDoc.exists) {
      // Un-vote
      tx.delete(voteRef);
      tx.update(ref, { helpful: Math.max(0, current - 1), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      toggled = false;
    } else {
      // Vote
      tx.set(voteRef, { uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.update(ref, { helpful: current + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      toggled = true;
    }
  });

  return { helpful: toggled };
});

// ── adminModerateReview ───────────────────────────────────────────────────────
exports.adminModerateReview = onCall({ region: "us-central1" }, async (req) => {
  if (!_isAdmin(req)) throw new HttpsError("permission-denied", "Admins only.");
  const { reviewId, action, note } = req.data || {};
  /* kind: 'review' (reviews/{id}) | 'unboxing' (unboxingReviews/{id}) — the same state machine and history */
  const kind = (req.data || {}).kind === 'unboxing' ? 'unboxing' : 'review';
  const COLL = kind === 'unboxing' ? 'unboxingReviews' : 'reviews';
  if (!reviewId || typeof reviewId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(reviewId)) throw new HttpsError("invalid-argument", "reviewId required.");
  /* The shared moderation vocabulary (one with the report queue): pending → approved | rejected |
     changes_requested | archived | removed. 'flagged' (legacy) moderates like pending. Restore = back to pending. */
  const T = {
    approve:         { to: "approved",          from: ["pending", "flagged", "changes_requested", "rejected", "archived"] },
    reject:          { to: "rejected",          from: ["pending", "flagged", "changes_requested", "approved"] },
    request_changes: { to: "changes_requested", from: ["pending", "flagged"] },
    archive:         { to: "archived",          from: ["pending", "flagged", "approved", "rejected", "changes_requested"] },
    remove:          { to: "removed",           from: ["pending", "flagged", "approved", "rejected", "changes_requested", "archived"] },
    restore:         { to: "pending",           from: ["archived", "removed"] },
  }[action];
  if (!T) throw new HttpsError("invalid-argument", "Invalid action.");

  const db  = _db();
  const ref = db.collection(COLL).doc(reviewId);
  const actor = req.auth.uid;
  const res = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new HttpsError("not-found", "Review not found.");
    const r = doc.data() || {};
    if ((r.authorUid || r.uid) === actor) throw new HttpsError("permission-denied", "You cannot moderate your own review.", { reason: "SELF_REVIEW" });
    /* self-interest: an admin who owns the reviewed target */
    let owner = null;
    if (kind === "unboxing") owner = r.sellerUid || null;
    else if (r.targetType === "seller") owner = r.targetId;
    else if (r.targetType === "product") {
      const p = await tx.get(db.collection("products").doc(String(r.targetId)));
      owner = p.exists ? (p.data().sellerUid || p.data().sellerId || p.data().shopId || null) : null;
    }
    if (owner && String(owner) === actor) throw new HttpsError("permission-denied", "You cannot moderate a review of your own listing.", { reason: "SELF_INTEREST" });
    const from = String(r.status || "pending");
    if (from === T.to) return { status: from, unchanged: true, targetId: r.targetId };          /* idempotent: no second decision */
    if (!T.from.includes(from)) throw new HttpsError("failed-precondition", "That action is not allowed on a " + from + " review.", { reason: "BAD_TRANSITION" });
    tx.update(ref, {
      status:          T.to,
      moderationNote:  _sanitize(note || "", 500),
      moderatedBy:     actor,
      moderatedAt:     admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("reviewModerationLog").doc(), { reviewId, kind, from, to: T.to, action, actorUid: actor,
      note: _sanitize(note || "", 500), targetId: r.targetId || null, targetType: r.targetType || null,
      at: admin.firestore.FieldValue.serverTimestamp() });
    return { status: T.to, unchanged: false, targetId: r.targetId };
  });

  // Publication follows the authoritative state: the summary counts APPROVED reviews only
  if (!res.unchanged && res.targetId && kind === "review") await _recalcSummary(res.targetId);
  return { status: res.status, unchanged: res.unchanged };
});
