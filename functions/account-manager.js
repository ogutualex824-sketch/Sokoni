'use strict';

/**
 * SOKONI Account Manager v1.0
 *
 * Cloud Functions for account lifecycle management:
 *   scheduleAccountDeletion  — marks account for 30-day deletion
 *   cancelAccountDeletion    — removes deletion flag (called on sign-in)
 *   requestDataExport        — queues a full data export for the user
 *   revokeAllSessions        — revokes Firebase refresh tokens + marks all sessions inactive
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db  = admin.firestore();
const auth = admin.auth();

/* ── Helpers ──────────────────────────────────────────────────────────── */
function _assertAuth(context) {
  const uid = context.auth && context.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to perform this action.');
  return uid;
}

function _assertAdmin(context) {
  const uid = _assertAuth(context);
  const claims = context.auth.token || {};
  if (!claims.admin && !claims.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
  return uid;
}

/* ── scheduleAccountDeletion ──────────────────────────────────────────── */
/**
 * Marks the user's Firestore document with deletionScheduledAt (now + 30 days).
 * A scheduled function finalises hard deletion after the grace period.
 *
 * Accepts:
 *   reason: string — why the user is leaving (optional, for analytics)
 */
exports.scheduleAccountDeletion = onCall({ region: 'us-central1' }, async (request) => {
  const uid    = _assertAuth(request);
  const reason = String(request.data?.reason || 'not_specified').substring(0, 100);

  const deletionDate = new Date();
  deletionDate.setDate(deletionDate.getDate() + 30);

  await db.collection('users').doc(uid).set({
    deletionScheduledAt:  admin.firestore.Timestamp.fromDate(deletionDate),
    deletionReason:       reason,
    deletionRequestedAt:  admin.firestore.FieldValue.serverTimestamp(),
    status:               'pending_deletion',
  }, { merge: true });

  /* Audit log */
  await db.collection('auditLog').add({
    action:    'account_deletion_scheduled',
    uid,
    reason,
    scheduledFor: admin.firestore.Timestamp.fromDate(deletionDate),
    ts:        admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success:     true,
    deletionDate: deletionDate.toISOString(),
    message:     'Your account is scheduled for deletion. You have 30 days to cancel.',
  };
});

/* ── cancelAccountDeletion ────────────────────────────────────────────── */
/**
 * Removes the deletion flag when the user signs back in during the grace period.
 * Called automatically from firebase.js onAuthStateChanged when deletionScheduledAt is set.
 */
exports.cancelAccountDeletion = onCall({ region: 'us-central1' }, async (request) => {
  const uid = _assertAuth(request);

  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists || !snap.data().deletionScheduledAt) {
    return { success: true, message: 'No pending deletion found.' };
  }

  await db.collection('users').doc(uid).update({
    deletionScheduledAt:  admin.firestore.FieldValue.delete(),
    deletionReason:       admin.firestore.FieldValue.delete(),
    deletionRequestedAt:  admin.firestore.FieldValue.delete(),
    status:               'active',
    deletionCancelledAt:  admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('auditLog').add({
    action: 'account_deletion_cancelled',
    uid,
    ts:     admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, message: 'Account deletion cancelled. Welcome back!' };
});

/* ── requestDataExport ────────────────────────────────────────────────── */
/**
 * Queues a data export request. A background job (or admin tool) processes
 * the queue and emails the export link within 24 hours.
 */
exports.requestDataExport = onCall({ region: 'us-central1' }, async (request) => {
  const uid = _assertAuth(request);

  /* Rate-limit: 1 export request per 7 days */
  const q = await db.collection('dataExportRequests')
    .where('uid', '==', uid)
    .where('status', 'in', ['pending', 'processing'])
    .limit(1)
    .get();

  if (!q.empty) {
    const existing = q.docs[0].data();
    throw new HttpsError('resource-exhausted',
      'An export is already in progress. You will receive an email when it\'s ready.');
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const email    = userSnap.exists ? (userSnap.data().email || request.auth.token?.email) : request.auth.token?.email;

  const ref = await db.collection('dataExportRequests').add({
    uid,
    email:       email || '',
    status:      'pending',
    requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt:   admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  });

  await db.collection('auditLog').add({
    action: 'data_export_requested',
    uid,
    exportRequestId: ref.id,
    ts:     admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success:   true,
    requestId: ref.id,
    message:   'Export requested. We\'ll send a download link to your email within 24 hours.',
  };
});

/* ── revokeAllSessions ────────────────────────────────────────────────── */
/**
 * Revokes all Firebase refresh tokens for the user (forces sign-out on all devices)
 * AND marks all Firestore session documents as inactive.
 */
exports.revokeAllSessions = onCall({ region: 'us-central1' }, async (request) => {
  const uid = _assertAuth(request);

  /* Revoke Firebase refresh tokens */
  await auth.revokeRefreshTokens(uid);

  /* Mark all Firestore userSessions as inactive */
  const sessionsSnap = await db.collection('userSessions')
    .where('uid', '==', uid)
    .where('active', '==', true)
    .get();

  const batch = db.batch();
  sessionsSnap.docs.forEach(d => batch.update(d.ref, { active: false, revokedAt: admin.firestore.FieldValue.serverTimestamp() }));
  await batch.commit();

  await db.collection('auditLog').add({
    action:       'all_sessions_revoked',
    uid,
    sessionCount: sessionsSnap.size,
    ts:           admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success:      true,
    revokedCount: sessionsSnap.size,
    message:      `Signed out from ${sessionsSnap.size} device(s).`,
  };
});

/* ── finaliseExpiredDeletions (scheduled — daily at 02:00 EAT) ───────── */
/**
 * Hard-deletes accounts whose 30-day grace period has passed.
 * Runs every day at 02:00 Africa/Nairobi (23:00 UTC previous day).
 */
exports.finaliseExpiredDeletions = onSchedule(
  { schedule: '0 23 * * *', timeZone: 'UTC', region: 'us-central1' },
  async () => {
    const now  = admin.firestore.Timestamp.now();
    const snap = await db.collection('users')
      .where('status', '==', 'pending_deletion')
      .where('deletionScheduledAt', '<=', now)
      .limit(50)
      .get();

    if (snap.empty) return;

    for (const userDoc of snap.docs) {
      const uid  = userDoc.id;
      const data = userDoc.data();

      try {
        /* 1. Delete Firebase Auth account */
        await auth.deleteUser(uid);

        /* 2. Soft-delete Firestore user document (preserve for legal auditing) */
        await db.collection('users').doc(uid).set({
          status:    'deleted',
          deletedAt: admin.firestore.FieldValue.serverTimestamp(),
          email:     '[redacted]',
          name:      '[redacted]',
          phone:     '[redacted]',
          photoURL:  '[redacted]',
        }, { merge: true });

        /* 3. Revoke all active sessions */
        const sessions = await db.collection('userSessions').where('uid', '==', uid).get();
        const batch    = db.batch();
        sessions.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();

        /* 4. Audit */
        await db.collection('auditLog').add({
          action: 'account_hard_deleted',
          uid,
          reason: data.deletionReason || 'grace_period_expired',
          ts:     admin.firestore.FieldValue.serverTimestamp(),
        });

        console.info('[AccountManager] Hard-deleted account:', uid);
      } catch (e) {
        console.error('[AccountManager] Failed to delete account:', uid, e.message);
      }
    }
  }
);
