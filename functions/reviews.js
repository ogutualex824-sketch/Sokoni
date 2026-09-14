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
 * targetId: the CANONICAL id of the target entity, resolved SERVER-SIDE by
 * _resolveCanonicalTarget(). Never the caller's raw input, never a display name.
 *
 * NOTE: this header previously documented a prefixed composite key
 * ("{type}_{entityId}"). No caller and no query in this file ever produced or
 * consumed that form, so it was corrected rather than implemented — adopting it
 * now would orphan every existing review document.
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

/* ── canonical target resolution ────────────────────────────────────────────
   The caller may IDENTIFY a target; only the server may DECIDE its id.

   Before this, targetId was stored exactly as supplied. Nothing checked that it
   resolved to a real entity, so a caller passing a display name or a stale id
   silently created reviews and a ratingsSummary/{thatString} document that no
   surface would ever query — "approved but invisible".

   Each targetType maps to an ordered list of source collections. The FIRST hit
   wins. A doc whose id is already the canonical key resolves to itself; an
   indirect record (businesses/{merchantId}) resolves through its owner field,
   because shops/ and sellers/ are keyed by owner uid while businesses/ is keyed
   by a generated merchantId — two different id spaces for the same real shop.

   Unresolvable input is REJECTED. Manufacturing a summary under an identifier
   nothing can query is the defect this function exists to prevent. */
const _TARGET_SOURCES = {
  /* shops/{uid} and sellers/{uid} are uid-keyed, so the doc id IS canonical.
     businesses/{merchantId} is not — resolve it through its owner field. */
  seller:        [{ col: 'sellers' }, { col: 'shops' },
                  { col: 'businesses', ownerField: ['uid', 'ownerId'] }],
  product:       [{ col: 'products' }],
  service:       [{ col: 'services' }, { col: 'providers' }],
  driver:        [{ col: 'drivers' }],
  education:     [{ col: 'courses' }, { col: 'providers' }],
  food:          [{ col: 'listings' }, { col: 'providers' }, { col: 'services' }],
  healthcare:    [{ col: 'providers' }, { col: 'services' }],
  entertainment: [{ col: 'listings' }, { col: 'providers' }, { col: 'services' }],
  legal:         [{ col: 'providers' }, { col: 'services' }],
};

/**
 * Resolve caller-supplied identification to the authoritative target id.
 * @returns {Promise<{canonicalId:string, submittedId:string, source:string}>}
 * @throws  HttpsError('not-found') when the target does not resolve.
 */
async function _resolveCanonicalTarget(targetType, rawId) {
  const sources = _TARGET_SOURCES[targetType];
  if (!sources) throw new HttpsError('invalid-argument', 'Unsupported targetType.');

  const db = _db();
  const submittedId = String(rawId || '').trim();
  if (!submittedId) throw new HttpsError('invalid-argument', 'targetId required.');

  for (const src of sources) {
    let snap;
    try { snap = await db.collection(src.col).doc(submittedId).get(); }
    catch (e) { continue; }
    if (!snap.exists) continue;

    if (!src.ownerField) {
      return { canonicalId: submittedId, submittedId, source: src.col };
    }
    const data = snap.data() || {};
    for (const f of src.ownerField) {
      const owner = data[f];
      if (owner && typeof owner === 'string') {
        return { canonicalId: owner, submittedId, source: src.col + '.' + f };
      }
    }
    /* The record exists but carries no owner link — it cannot be attributed, and
       guessing would attach the review to the wrong entity. */
    throw new HttpsError('failed-precondition',
      'Target exists but has no canonical owner; cannot attribute this review.');
  }

  throw new HttpsError('not-found',
    'Review target does not resolve to a known ' + targetType + '.');
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

// ── submitReview ──────────────────────────────────────────────────────────────
exports.submitReview = onCall({ region: "us-central1" }, async (req) => {
  const uid = _requireAuth(req);

  // Zero-trust input validation
  const { targetId, targetType, targetName, rating, title, body, orderId, images } = req.data;

  if (!targetId || typeof targetId !== "string" || targetId.length > 128) throw new HttpsError("invalid-argument", "targetId required.");
  if (!["product","seller","service","food","healthcare","entertainment","education","legal","driver"].includes(targetType)) {
    throw new HttpsError("invalid-argument", "Invalid targetType.");
  }
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

  /* The server decides the id. Runs BEFORE the duplicate check so "one review per
     user per target" is enforced against the canonical target — otherwise the same
     shop reached by two different identifiers would accept two reviews. */
  const _resolved   = await _resolveCanonicalTarget(targetType, targetId);
  const canonicalId = _resolved.canonicalId;

  // One review per user per target
  const existing = await db.collection("reviews")
    .where("targetId", "==", canonicalId)
    .where("authorUid", "==", uid)
    .limit(1).get();
  if (!existing.empty) throw new HttpsError("already-exists", "You have already reviewed this.");

  // Verify purchase (non-blocking for service reviews — orderId optional)
  if (orderId) {
    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists || orderDoc.data().buyerUid !== uid) {
      throw new HttpsError("permission-denied", "Order not found or not yours.");
    }
    if (!["completed","delivered"].includes(orderDoc.data().status)) {
      throw new HttpsError("failed-precondition", "Order must be completed before reviewing.");
    }
  }

  const cleanTitle = _sanitize(title, 120);
  const cleanBody  = _sanitize(body, 2000);
  const safeImages = Array.isArray(images)
    ? images.filter(u => typeof u === "string" && u.startsWith("https://")).slice(0, 5)
    : [];

  // Auto-approve unless body looks suspicious (profanity/spam check placeholder)
  const autoApprove = true; // extend with moderation API as needed

  const reviewRef = db.collection("reviews").doc();
  await reviewRef.set({
    targetId: canonicalId,
    /* What the caller actually sent. Kept for audit and for diagnosing legacy
       rows — never used as a key. */
    submittedTargetId: _resolved.submittedId,
    targetResolvedFrom: _resolved.source,
    targetType,
    targetName: _sanitize(targetName, 120),
    authorUid:  uid,
    rating,
    title:   cleanTitle,
    body:    cleanBody,
    images:  safeImages,
    orderId: orderId || null,
    helpful: 0,
    flags:   0,
    status:  autoApprove ? "approved" : "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (autoApprove) await _recalcSummary(canonicalId);

  return { reviewId: reviewRef.id, status: autoApprove ? "approved" : "pending", targetId: canonicalId };
});

// ── getReviews ────────────────────────────────────────────────────────────────
exports.getReviews = onCall({ region: "us-central1" }, async (req) => {
  const { targetId, targetType, sort = "recent", limit: lim = 20, startAfter } = req.data;
  if (!targetId) throw new HttpsError("invalid-argument", "targetId required.");

  /* Reads MUST canonicalise the same way writes do, or a caller identifying a shop
     by one id would query a key writes never produce. targetType is optional so
     existing callers keep working; when absent the raw id is used unchanged. */
  let queryId = String(targetId).trim();
  let legacyId = null;
  if (targetType) {
    const r = await _resolveCanonicalTarget(targetType, targetId);
    queryId = r.canonicalId;
    if (r.submittedId !== r.canonicalId) legacyId = r.submittedId;
  }

  const safeLimit = Math.min(50, Math.max(1, Number(lim) || 20));
  const db = _db();

  let q = db.collection("reviews")
    .where("targetId", "==", queryId)
    .where("status", "==", "approved");

  if (sort === "highest")  q = q.orderBy("rating", "desc").orderBy("createdAt", "desc");
  else if (sort === "lowest")  q = q.orderBy("rating", "asc").orderBy("createdAt", "desc");
  else if (sort === "helpful") q = q.orderBy("helpful", "desc").orderBy("createdAt", "desc");
  else                          q = q.orderBy("createdAt", "desc");

  if (startAfter) {
    const cursorDoc = await db.collection("reviews").doc(startAfter).get();
    if (cursorDoc.exists) q = q.startAfter(cursorDoc);
  }

  let snap = await q.limit(safeLimit).get();

  /* TRANSITIONAL. Reviews written before canonicalisation are stored under the
     id the caller sent. Rather than rewrite history (a migration decision, not a
     read-path one), fall back to that id when the canonical key has nothing. */
  if (snap.empty && legacyId) {
    let lq = db.collection("reviews")
      .where("targetId", "==", legacyId)
      .where("status", "==", "approved");
    if (sort === "highest")      lq = lq.orderBy("rating", "desc").orderBy("createdAt", "desc");
    else if (sort === "lowest")  lq = lq.orderBy("rating", "asc").orderBy("createdAt", "desc");
    else if (sort === "helpful") lq = lq.orderBy("helpful", "desc").orderBy("createdAt", "desc");
    else                         lq = lq.orderBy("createdAt", "desc");
    snap = await lq.limit(safeLimit).get();
  }

  // Fetch summary
  const summaryDoc = await db.collection("ratingsSummary").doc(queryId).get();
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
  const { reviewId, action, note } = req.data;
  if (!reviewId) throw new HttpsError("invalid-argument", "reviewId required.");
  if (!["approve","reject","restore"].includes(action)) throw new HttpsError("invalid-argument", "Invalid action.");

  const db  = _db();
  const ref = db.collection("reviews").doc(reviewId);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError("not-found", "Review not found.");

  const statusMap = { approve: "approved", reject: "rejected", restore: "approved" };
  await ref.update({
    status:          statusMap[action],
    moderationNote:  _sanitize(note || "", 500),
    moderatedBy:     req.auth.uid,
    moderatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
  });

  // Recalc summary after moderation
  await _recalcSummary(doc.data().targetId);

  return { status: statusMap[action] };
});
