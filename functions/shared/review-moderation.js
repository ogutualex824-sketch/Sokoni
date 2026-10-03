'use strict';
/**
 * REVIEW MODERATION — the ONE transition module for review / unboxing status (sokoni-5b, 2026-10-03).
 *
 * Every writer of review status uses THIS file: reviews.js adminModerateReview (AdminOS), and the report authority
 * (trust-safety.js, sokoni-e3) when a report ABOUT a review is upheld or restored. Copies elsewhere are byte-identical
 * and pinned by a byte-equality test — two writers that drift would be two authorities.
 *
 * No firebase imports: db / FieldValue are injected, so the file is lineage-portable. Errors are ModerationError
 * {code (an HttpsError code), reason, message}; each caller maps them to its own HttpsError.
 *
 * States (shared with the report queue): pending | flagged (legacy, moderates like pending) | approved | rejected |
 * changes_requested | archived | removed. Restore = back to PENDING (re-review), never straight to public.
 * Collections: kind 'review' → reviews/{id} (+ ratingsSummary/{targetId}); kind 'unboxing' → unboxingReviews/{id}.
 */
const TRANSITIONS = Object.freeze({
  approve:         Object.freeze({ to: 'approved',          from: ['pending', 'flagged', 'changes_requested', 'rejected', 'archived'] }),
  reject:          Object.freeze({ to: 'rejected',          from: ['pending', 'flagged', 'changes_requested', 'approved'] }),
  request_changes: Object.freeze({ to: 'changes_requested', from: ['pending', 'flagged'] }),
  archive:         Object.freeze({ to: 'archived',          from: ['pending', 'flagged', 'approved', 'rejected', 'changes_requested'] }),
  remove:          Object.freeze({ to: 'removed',           from: ['pending', 'flagged', 'approved', 'rejected', 'changes_requested', 'archived'] }),
  restore:         Object.freeze({ to: 'pending',           from: ['archived', 'removed'] }),
});
const LOG_COLLECTION = 'reviewModerationLog';
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

class ModerationError extends Error {
  constructor(code, reason, message) { super(message); this.name = 'ModerationError'; this.code = code; this.reason = reason; }
}
function collectionFor(kind) { return kind === 'unboxing' ? 'unboxingReviews' : 'reviews'; }
function cleanNote(s) { return typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim().slice(0, 500) : ''; }

/**
 * One transition inside the caller's transaction. ALL reads happen before any write.
 * @param tx  Firestore transaction
 * @param o   { db, FieldValue, kind:'review'|'unboxing', reviewId, action, actorUid, note?, source? }
 * @returns   { status, unchanged, targetId, kind, from }
 */
async function transitionReview(tx, o) {
  const { db, FieldValue } = o;
  const kind = o.kind === 'unboxing' ? 'unboxing' : 'review';
  const T = TRANSITIONS[o.action];
  if (!T) throw new ModerationError('invalid-argument', 'BAD_ACTION', 'Invalid action.');
  if (!ID_RE.test(String(o.reviewId || ''))) throw new ModerationError('invalid-argument', 'BAD_ID', 'reviewId required.');
  const actor = String(o.actorUid || '');
  if (!actor) throw new ModerationError('permission-denied', 'NO_ACTOR', 'An authorised moderator is required.');
  const ref = db.collection(collectionFor(kind)).doc(String(o.reviewId));
  const doc = await tx.get(ref);
  if (!doc.exists) throw new ModerationError('not-found', 'NOT_FOUND', 'Review not found.');
  const r = doc.data() || {};
  const targetId = r.targetId || r.productId || null;
  let owner = null;
  if (kind === 'unboxing') owner = r.sellerUid || null;
  else if (r.targetType === 'seller') owner = r.targetId || null;
  else if (r.targetType === 'product' && targetId) {
    const p = await tx.get(db.collection('products').doc(String(targetId)));
    owner = p.exists ? (p.data().sellerUid || p.data().sellerId || p.data().shopId || null) : null;
  }
  if ((r.authorUid || r.uid) === actor) throw new ModerationError('permission-denied', 'SELF_REVIEW', 'You cannot moderate your own review.');
  if (owner && String(owner) === actor) throw new ModerationError('permission-denied', 'SELF_INTEREST', 'You cannot moderate a review of your own listing.');
  const from = String(r.status || 'pending');
  if (from === T.to) return { status: from, unchanged: true, targetId, kind, from };           /* idempotent */
  if (!T.from.includes(from)) throw new ModerationError('failed-precondition', 'BAD_TRANSITION', 'That action is not allowed on a ' + from + ' review.');
  const note = cleanNote(o.note);
  tx.update(ref, { status: T.to, moderationNote: note, moderatedBy: actor,
    moderatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  tx.set(db.collection(LOG_COLLECTION).doc(), { reviewId: String(o.reviewId), kind, from, to: T.to, action: o.action, actorUid: actor,
    note, source: typeof o.source === 'string' ? o.source.slice(0, 120) : 'admin',
    targetId: targetId ? String(targetId) : null, targetType: r.targetType || (kind === 'unboxing' ? 'product' : null),
    at: FieldValue.serverTimestamp() });
  return { status: T.to, unchanged: false, targetId, kind, from };
}
const removeReview  = (tx, o) => transitionReview(tx, Object.assign({}, o, { action: 'remove' }));
const restoreReview = (tx, o) => transitionReview(tx, Object.assign({}, o, { action: 'restore' }));

/** ratingsSummary/{targetId} from APPROVED reviews only: avg rounded to 1 dp, count. Run AFTER the transaction. */
async function recomputeRatingsSummary(db, FieldValue, targetId) {
  const snap = await db.collection('reviews').where('targetId', '==', targetId).where('status', '==', 'approved').get();
  let sum = 0;
  snap.docs.forEach((d) => { sum += (d.data().rating || 0); });
  const count = snap.size;
  const avg = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
  await db.collection('ratingsSummary').doc(String(targetId)).set({ targetId, avg, count, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { avg, count };
}

module.exports = { TRANSITIONS, LOG_COLLECTION, ModerationError, collectionFor, transitionReview, removeReview, restoreReview, recomputeRatingsSummary };
