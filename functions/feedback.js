"use strict";
/* ═══════════════════════════════════════════════════════════════════
   functions/feedback.js
   User feedback collection and admin triage.

   Exports:
     submitFeedback       — public callable — submit bug/feature/rating
     getFeedbackItems     — admin callable  — paginated feedback list
     updateFeedbackStatus — admin callable  — triage action
═══════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const ALLOWED_TYPES    = ["bug", "feature", "page_rating", "incorrect_listing", "other"];
const ALLOWED_STATUSES = ["new", "reviewing", "resolved", "wontfix"];

function requireAdmin(request) {
  if (!request.auth?.token?.isAdmin && !request.auth?.token?.isSuperAdmin) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
}

function esc(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[<>"'&]/g, c =>
    ({ "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "&": "&amp;" })[c]
  );
}

/* ── submitFeedback ──────────────────────────────────────────────── */
exports.submitFeedback = onCall(
  { maxInstances: 80 },
  async (request) => {
    const { type, message, rating, pageUrl, productId } = request.data || {};

    if (!ALLOWED_TYPES.includes(type)) {
      throw new HttpsError("invalid-argument", "Invalid feedback type");
    }

    const msg = String(message || "").trim();
    if (msg.length < 5)    throw new HttpsError("invalid-argument", "Message must be at least 5 characters");
    if (msg.length > 2000) throw new HttpsError("invalid-argument", "Message exceeds 2000 character limit");

    const db  = getFirestore();
    const uid = request.auth?.uid || null;

    await db.collection("feedback").add({
      type,
      message:   esc(msg),
      rating:    (type === "page_rating" && typeof rating === "number")
        ? Math.max(1, Math.min(5, Math.round(rating))) : null,
      pageUrl:   pageUrl   ? String(pageUrl).substring(0, 500)   : null,
      productId: productId ? String(productId).substring(0, 100) : null,
      uid,
      status:    "new",
      adminNote: null,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { success: true };
  }
);

/* ── getFeedbackItems ────────────────────────────────────────────── */
exports.getFeedbackItems = onCall(
  { maxInstances: 10 },
  async (request) => {
    requireAdmin(request);

    const { type, status, limit: lim = 50 } = request.data || {};
    const db = getFirestore();

    let q = db.collection("feedback").orderBy("createdAt", "desc");
    if (type   && ALLOWED_TYPES.includes(type))     q = q.where("type",   "==", type);
    if (status && ALLOWED_STATUSES.includes(status)) q = q.where("status", "==", status);
    q = q.limit(Math.min(Number(lim) || 50, 100));

    const snap = await q.get();

    return snap.docs.map(d => {
      const v = d.data();
      return {
        id:        d.id,
        type:      v.type,
        message:   v.message,
        rating:    v.rating,
        pageUrl:   v.pageUrl,
        productId: v.productId,
        uid:       v.uid,
        status:    v.status,
        adminNote: v.adminNote,
        createdAt: v.createdAt?.toMillis() || null,
      };
    });
  }
);

/* ── updateFeedbackStatus ────────────────────────────────────────── */
exports.updateFeedbackStatus = onCall(
  { maxInstances: 10 },
  async (request) => {
    requireAdmin(request);

    const { id, status, adminNote } = request.data || {};

    if (!id || typeof id !== "string") {
      throw new HttpsError("invalid-argument", "id required");
    }
    if (!ALLOWED_STATUSES.includes(status)) {
      throw new HttpsError("invalid-argument", `status must be one of: ${ALLOWED_STATUSES.join(", ")}`);
    }

    const db = getFirestore();
    await db.collection("feedback").doc(id).update({
      status,
      adminNote: adminNote ? esc(String(adminNote).substring(0, 1000)) : null,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: request.auth.uid,
    });

    return { success: true };
  }
);
