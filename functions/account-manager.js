'use strict';

/**
 * SOKONI Account Manager v1.0
 *
 * Cloud Functions for account lifecycle management:
 *   scheduleAccountDeletion  — marks account for 30-day deletion
 *   cancelAccountDeletion    — removes deletion flag (called on sign-in)
 *   revokeAllSessions        — revokes Firebase refresh tokens + marks all sessions inactive
 *
 * (requestDataExport was removed from here — the canonical version is ./data-export.js.)
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

/* ── Session lookup, provider-agnostic ────────────────────────────────────
   userSessions documents are written by session-manager.js:69 with a userEmail
   field and NO uid field. Both call sites here previously queried
   .where('uid','==',uid), which matches zero documents for every user that has
   ever existed — so revokeAllSessions always reported 0 devices, and account
   erasure never removed the session rows, leaving userEmail/deviceName/browser
   behind after users/{uid} had been redacted. That is an incomplete erasure.

   Queries both keys and unions the result, so this is correct before AND after
   sessions are re-keyed on uid (RC1 Priority 2). A phone-only account has no
   email and no session documents at all, so it correctly yields nothing. */
async function _findUserSessions(uid, email, activeOnly) {
  const col = db.collection('userSessions');
  const queries = [col.where('uid', '==', uid)];
  if (email) queries.push(col.where('userEmail', '==', String(email).toLowerCase().trim()));

  const snaps = await Promise.all(queries.map((q) =>
    (activeOnly ? q.where('active', '==', true) : q).get().catch(() => null)
  ));

  const byId = new Map();
  for (const s of snaps) {
    if (!s) continue;
    for (const d of s.docs) byId.set(d.id, d);   /* union — a doc may match both */
  }
  return [...byId.values()];
}

/* Resolve the account's email even when the caller token lacks one. */
async function _resolveEmail(uid, tokenEmail) {
  if (tokenEmail) return tokenEmail;
  try {
    const s = await db.collection('users').doc(uid).get();
    return (s.exists && s.data().email) || null;
  } catch (_) { return null; }
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

/* ── requestDataExport — REMOVED (single-source reconciliation, ODPC should-fix #8) ──
   The canonical requestDataExport lives in ./data-export.js and is the deployed entry
   point (functions/index.js). That version writes BOTH dataExportRequests (status) AND
   dataExportQueue/{id} so the processDataExport worker actually builds the export, and it
   enforces App Check. This module's older duplicate wrote only dataExportRequests (worker
   never fired) and skipped App Check — so it was a shadowed landmine. Deleted to leave ONE
   implementation; nothing references account-manager.requestDataExport. */

/* ── revokeAllSessions ────────────────────────────────────────────────── */
/**
 * Revokes all Firebase refresh tokens for the user (forces sign-out on all devices)
 * AND marks all Firestore session documents as inactive.
 */
exports.revokeAllSessions = onCall({ region: 'us-central1' }, async (request) => {
  const uid = _assertAuth(request);

  /* Revoke Firebase refresh tokens. This is the authoritative sign-out: it
     invalidates every issued token regardless of what the session rows say. */
  await auth.revokeRefreshTokens(uid);

  /* Mark Firestore userSessions inactive (see _findUserSessions above). */
  const email = await _resolveEmail(uid, request.auth.token && request.auth.token.email);
  const docs  = await _findUserSessions(uid, email, true);

  if (docs.length) {
    const batch = db.batch();
    docs.forEach(d => batch.update(d.ref, {
      active:    false,
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
    await batch.commit();
  }

  await db.collection('auditLog').add({
    action:       'all_sessions_revoked',
    uid,
    sessionCount: docs.length,
    ts:           admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success:      true,
    revokedCount: docs.length,
    message:      `Signed out from ${docs.length} device(s).`,
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
        /* Order matters. This previously deleted the Auth account FIRST; if the
           redaction write below then failed, the next run's auth.deleteUser threw
           user-not-found, hit the catch, and skipped redaction again — leaving the
           account permanently stuck in pending_deletion with full PII intact.

           Erasure now happens before the irreversible step, so a partial failure
           leaves the record redacted and retryable rather than exposed and stuck. */

        /* 1. Read the email BEFORE redacting it — needed to find session rows. */
        const email = data.email || null;

        /* 2. Delete session documents. They carry userEmail, deviceName and
              browser, so leaving them behind would defeat the redaction below. */
        const sessions = await _findUserSessions(uid, email, false);
        if (sessions.length) {
          const batch = db.batch();
          sessions.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }

        /* 3. Redact the Firestore user document (shell preserved for audit). */
        await db.collection('users').doc(uid).set({
          status:    'deleted',
          deletedAt: admin.firestore.FieldValue.serverTimestamp(),
          email:     '[redacted]',
          name:      '[redacted]',
          phone:     '[redacted]',
          photoURL:  '[redacted]',
        }, { merge: true });

        /* 3b. Cross-collection erasure driven by the explicit purge spec — DELETE personal
              collections, ANONYMIZE records under statutory retention (orders/wallet/tax kept,
              PII stripped), purge Storage. Then write an IMMUTABLE erasure audit event BEFORE
              the irreversible auth delete, so completion is evidenced even if a later step fails. */
        const _purge   = require('./account-purge-spec');
        let _summary   = { deleted: [], anonymized: [], retained: [], storage: [] };
        try { _summary = await _purge.purgeUserData(db, admin, uid); }
        catch (pe) { console.error('[AccountManager] cross-collection purge failed:', uid, pe.message); }
        await db.collection('erasureLog').add({
          uid,
          requestedAt:           data.deletionScheduledAt || null,
          executedAt:            admin.firestore.FieldValue.serverTimestamp(),
          workerVersion:         _purge.PURGE_WORKER_VERSION,
          collectionsDeleted:    _summary.deleted,
          collectionsAnonymized: _summary.anonymized,
          collectionsRetained:   _summary.retained,
          storagePurged:         _summary.storage,
          outcome:               'success',
        }).catch(() => {});

        /* 4. Delete the Firebase Auth account — the irreversible step, last.
              Tolerate an already-deleted account so a retry can still complete. */
        try {
          await auth.deleteUser(uid);
        } catch (authErr) {
          if (!authErr || authErr.code !== 'auth/user-not-found') throw authErr;
          console.warn('[AccountManager] Auth account already absent, continuing:', uid);
        }

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
