/* ============================================================================
   SOKONI — Application REVIEW workflow (2026-10-01)
   ----------------------------------------------------------------------------
   The AdminOS Applications queue already decides applications through applicationDecide (approve / reject /
   suspend / request_info) and repairs projections through applicationReconcile — both in
   application-lifecycle.js, owned by sokoni-27 and trusted by the K13-B decision chain.
   This module adds ONLY the four missing review tools, with NO second writer of a decision:
     claim / release   — one reviewer at a time (transactional; only when unclaimed or already yours;
                         approving does NOT require a claim, so a lost reviewer never blocks the queue)
     note              — internal reviewer notes (admin-only; never applicant-readable)
     archive / unarchive — a QUEUE VIEW state, not an application status (K13-C's decisive-status lists and
                         canonStatus do not know 'archived', so it never touches applications/*)
     history           — adminAudit rows for the application (read through this callable; ordered in memory,
                         so no new composite index is needed)
   Writes ONLY applicationReviews/{appId} (+ /notes/*) and one adminAudit row per action.
   NEVER writes applications/* or applicationDecisions/*.
   ============================================================================ */
'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : null));
const clean = (v, max) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, ' ').trim().slice(0, max) : '');
const isAdmin = (req) => !!(req.auth && req.auth.token && (req.auth.token.admin === true || req.auth.token.superAdmin === true));

async function handle(req) {
  if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Administrator access required.');
  const uid = req.auth.uid;
  const d = (req.data && typeof req.data === 'object') ? req.data : {};
  const appId = String(d.applicationId || '');
  if (!ID_RE.test(appId)) throw new HttpsError('invalid-argument', 'Invalid application.');
  const appRef = db().collection('applications').doc(appId);
  const revRef = db().collection('applicationReviews').doc(appId);
  const audit = (tx, action, extra) => tx.set(db().collection('adminAudit').doc(), { action: 'application_review_' + action, applicationId: appId, performedBy: uid, ...(extra || {}), createdAt: ts() });

  switch (d.action) {
    case 'claim':
    case 'release': {
      const out = await db().runTransaction(async (tx) => {
        const [a, r] = await Promise.all([tx.get(appRef), tx.get(revRef)]);
        if (!a.exists) throw new HttpsError('not-found', 'Application not found.');
        const cur = r.exists ? r.data() : {};
        if (d.action === 'claim') {
          if (cur.reviewerUid && cur.reviewerUid !== uid && d.takeOver !== true) throw new HttpsError('failed-precondition', 'Another reviewer has claimed this application.', { reviewerUid: cur.reviewerUid });
          tx.set(revRef, { applicationId: appId, reviewerUid: uid, claimedAt: ts(), ...(cur.reviewerUid && cur.reviewerUid !== uid ? { takenOverFrom: cur.reviewerUid } : {}) }, { merge: true });
          audit(tx, d.takeOver === true && cur.reviewerUid && cur.reviewerUid !== uid ? 'takeover' : 'claim', cur.reviewerUid && cur.reviewerUid !== uid ? { previousReviewer: cur.reviewerUid } : null);
          return { reviewerUid: uid };
        }
        if (cur.reviewerUid !== uid) throw new HttpsError('failed-precondition', 'You have not claimed this application.');
        tx.set(revRef, { reviewerUid: null, releasedAt: ts() }, { merge: true });
        audit(tx, 'release');
        return { reviewerUid: null };
      });
      return { ok: true, ...out };
    }
    case 'note': {
      const text = clean(d.text, 2000);
      if (!text) throw new HttpsError('invalid-argument', 'Write a note.');
      const noteRef = revRef.collection('notes').doc();
      await db().runTransaction(async (tx) => {
        const a = await tx.get(appRef);
        if (!a.exists) throw new HttpsError('not-found', 'Application not found.');
        tx.set(revRef, { applicationId: appId, notesCount: admin.firestore.FieldValue.increment(1), lastNoteAt: ts() }, { merge: true });
        tx.create(noteRef, { text, by: uid, at: ts() });
        audit(tx, 'note', { noteId: noteRef.id });   /* the note TEXT stays in the notes subcollection */
      });
      return { ok: true, noteId: noteRef.id };
    }
    case 'archive':
    case 'unarchive': {
      await db().runTransaction(async (tx) => {
        const a = await tx.get(appRef);
        if (!a.exists) throw new HttpsError('not-found', 'Application not found.');
        tx.set(revRef, { applicationId: appId, archived: d.action === 'archive', archivedAt: d.action === 'archive' ? ts() : null, archivedBy: d.action === 'archive' ? uid : null }, { merge: true });
        audit(tx, d.action);
      });
      return { ok: true, archived: d.action === 'archive' };
    }
    case 'history': {
      const [rev, notes, auditSnap] = await Promise.all([
        revRef.get(),
        revRef.collection('notes').limit(200).get(),
        db().collection('adminAudit').where('applicationId', '==', appId).limit(200).get(),
      ]);
      const r = rev.exists ? rev.data() : {};
      const events = auditSnap.docs.map((x) => { const e = x.data(); return { id: x.id, action: e.action, by: e.performedBy || null, reason: e.reason || null, at: ms(e.createdAt) }; })
        .sort((a, b) => (b.at || 0) - (a.at || 0));
      return { ok: true, review: { reviewerUid: r.reviewerUid || null, claimedAt: ms(r.claimedAt), archived: r.archived === true },
        notes: notes.docs.map((x) => { const n = x.data(); return { id: x.id, text: n.text, by: n.by, at: ms(n.at) }; }).sort((a, b) => (b.at || 0) - (a.at || 0)),
        events };
    }
    default:
      throw new HttpsError('invalid-argument', 'action must be claim, release, note, archive, unarchive or history.');
  }
}

exports.applicationReview = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, async (req) => {
  try { return await handle(req); }
  catch (e) { if (e instanceof HttpsError) throw e; throw new HttpsError('internal', 'Something went wrong. Please try again.'); }
});
exports._test = { handle };
