'use strict';

/**
 * Super Admin Cloud Functions v1.0
 * SOKONI Platform — Gen2 onCall, Node.js 22
 *
 * Exports:
 *   setUserRole            — assign a platform role via custom claims   (superAdmin only)
 *   suspendUser            — disable / re-enable a Firebase Auth user   (superAdmin only)
 *   sendPlatformBroadcast  — create a global broadcast + queue entry    (admin | superAdmin)
 *
 * Security contract:
 *   - Every function checks Firebase Auth token claims before any logic.
 *   - Every state-changing action is written to `auditLog` with actor, target, and timestamp.
 *   - Input is validated and sanitised before any Firestore write.
 *   - No composite indexes are required — all queries use single-field filters or document reads.
 */

const { onCall } = require('firebase-functions/v2/https');
const { getAuth }                   = require('firebase-admin/auth');
const { getFirestore, FieldValue }  = require('firebase-admin/firestore');
const { checkRateLimit } = require('./redis-rate-limiter');   /* HIGH-06 — existing limiter, not a new one */

/* ── Constants ──────────────────────────────────────────────────────────────── */

const VALID_ROLES = ['buyer', 'seller', 'driver', 'admin', 'superAdmin', 'moderator'];

const VALID_PRIORITIES = ['info', 'warning', 'critical'];
const VALID_AUDIENCES  = ['all', 'buyers', 'sellers', 'drivers'];

/* ── Guards ─────────────────────────────────────────────────────────────────── */

/**
 * Throws unless the caller holds a verified `superAdmin` custom claim.
 * Deliberately does NOT fall through to `admin` — only true superAdmins
 * may manage roles and suspend accounts.
 */
function _requireSuperAdmin(ctx) {
  if (!ctx.auth || ctx.auth.token.superAdmin !== true) {
    throw Object.assign(new Error('PERMISSION_DENIED: superAdmin claim required'), {
      code: 'permission-denied',
    });
  }
}

/**
 * Throws unless the caller holds `admin` OR `superAdmin` custom claim.
 */
function _requireAdmin(ctx) {
  if (!ctx.auth || (!ctx.auth.token.admin && !ctx.auth.token.superAdmin)) {
    throw Object.assign(new Error('PERMISSION_DENIED: admin claim required'), {
      code: 'permission-denied',
    });
  }
}

/* ── Sanitisation helpers ────────────────────────────────────────────────────── */

/**
 * Strip all HTML tags from a string to prevent stored XSS.
 * This is a lightweight guard; the platform's CSP and output-encoding layers
 * provide additional defence-in-depth.
 */
function _stripHtml(str) {
  return String(str || '').replace(/<[^>]*>/g, '').trim();
}

/* ── Audit helper ────────────────────────────────────────────────────────────── */

/**
 * Writes a record to the `auditLog` collection.
 * Deliberately fire-and-forget — a logging failure must never block the
 * primary operation, but we still await it so errors surface in CF logs.
 *
 * @param {object} params
 * @param {string} params.actor      - UID of the caller
 * @param {string} params.action     - machine-readable action key
 * @param {string} params.resource   - "collection/docId" path of the affected resource
 * @param {object} params.details    - arbitrary detail payload
 * @param {'low'|'medium'|'high'|'critical'} params.severity
 */
async function _auditLog({ actor, action, resource, details, severity }) {
  const db = getFirestore();
  await db.collection('auditLog').add({
    actor,
    action,
    resource,
    details,
    severity,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CF 1 — setUserRole
   Assigns one of the platform's six roles to a user by setting Firebase Auth
   custom claims. The claims map controls access in both Firestore security
   rules and CF guards.

   Input  : { uid: string, role: string }
   Returns: { success: true, uid, role }
   Guard  : superAdmin only
═══════════════════════════════════════════════════════════════════════════════ */
exports.setUserRole = onCall({ cors: true, region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, async (request) => {
  _requireSuperAdmin(request);
  /* HIGH-06: throttle a money/privilege endpoint. Throws resource-exhausted. */
  await checkRateLimit(request, 'admin');

  const { uid, role } = request.data || {};

  // ── Validate input ──────────────────────────────────────────────────────────
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    throw new Error('INVALID_ARGUMENT: uid is required');
  }
  if (!role || !VALID_ROLES.includes(role)) {
    throw new Error(`INVALID_ARGUMENT: role must be one of [${VALID_ROLES.join(', ')}]`);
  }

  const cleanUid  = uid.trim();
  const cleanRole = role;

  // ── Verify the target user exists before touching claims ────────────────────
  // This prevents accidentally creating phantom custom-claim entries.
  let targetUser;
  try {
    targetUser = await getAuth().getUser(cleanUid);
  } catch (err) {
    throw new Error(`NOT_FOUND: user ${cleanUid} does not exist`);
  }

  // ── Build minimal, non-overlapping custom claims ────────────────────────────
  // Only the flags relevant to the new role are set to `true`; all others are
  // explicitly `false` so previous role claims are always cleared atomically.
  const claims = {
    admin:      cleanRole === 'admin'      || cleanRole === 'superAdmin',
    superAdmin: cleanRole === 'superAdmin',
    seller:     cleanRole === 'seller',
    driver:     cleanRole === 'driver',
    moderator:  cleanRole === 'moderator',
    // buyer is the default — no elevated claim needed, but we track it explicitly
    buyer:      cleanRole === 'buyer',
  };

  await getAuth().setCustomUserClaims(cleanUid, claims);

  // ── Mirror role into Firestore so the users collection stays consistent ──────
  const db = getFirestore();
  await db.collection('users').doc(cleanUid).set(
    { role: cleanRole, roleUpdatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  // ── Audit ───────────────────────────────────────────────────────────────────
  await _auditLog({
    actor:    request.auth.uid,
    action:   'setUserRole',
    resource: `users/${cleanUid}`,
    details:  { uid: cleanUid, newRole: cleanRole, claims, targetEmail: targetUser.email || null },
    severity: 'high',
  });

  return { success: true, uid: cleanUid, role: cleanRole };
});

/* ═══════════════════════════════════════════════════════════════════════════════
   CF 2 — suspendUser
   Disables or re-enables a Firebase Auth account and records the suspension
   state in Firestore. Suspended users cannot sign in or call authenticated CFs.

   Input  : { uid: string, suspend: boolean, reason?: string }
   Returns: { success: true, uid, suspended: boolean }
   Guard  : superAdmin only
═══════════════════════════════════════════════════════════════════════════════ */
exports.suspendUser = onCall({ cors: true, region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, async (request) => {
  _requireSuperAdmin(request);

  const { uid, suspend, reason } = request.data || {};

  // ── Validate input ──────────────────────────────────────────────────────────
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    throw new Error('INVALID_ARGUMENT: uid is required');
  }
  if (typeof suspend !== 'boolean') {
    throw new Error('INVALID_ARGUMENT: suspend must be a boolean');
  }

  const cleanUid    = uid.trim();
  const cleanReason = reason ? _stripHtml(String(reason)).slice(0, 500) : null;

  // ── Guard: superAdmin cannot suspend themselves ──────────────────────────────
  if (cleanUid === request.auth.uid) {
    throw new Error('INVALID_ARGUMENT: cannot suspend your own account');
  }

  // ── Verify target user exists ───────────────────────────────────────────────
  let targetUser;
  try {
    targetUser = await getAuth().getUser(cleanUid);
  } catch (err) {
    throw new Error(`NOT_FOUND: user ${cleanUid} does not exist`);
  }

  // ── Guard: never suspend another superAdmin ─────────────────────────────────
  if (targetUser.customClaims && targetUser.customClaims.superAdmin === true && suspend) {
    throw new Error('PERMISSION_DENIED: cannot suspend a superAdmin account');
  }

  // ── Disable / enable in Firebase Auth ──────────────────────────────────────
  await getAuth().updateUser(cleanUid, { disabled: suspend });

  // ── Persist suspension state to Firestore ──────────────────────────────────
  const db = getFirestore();
  const updatePayload = suspend
    ? {
        suspended:       true,
        suspendedAt:     FieldValue.serverTimestamp(),
        suspendReason:   cleanReason,
        suspendedBy:     request.auth.uid,
        reinstatedAt:    null,
        reinstatedBy:    null,
      }
    : {
        suspended:       false,
        suspendedAt:     null,
        suspendReason:   null,
        suspendedBy:     null,
        reinstatedAt:    FieldValue.serverTimestamp(),
        reinstatedBy:    request.auth.uid,
      };

  await db.collection('users').doc(cleanUid).set(updatePayload, { merge: true });

  // ── Audit ───────────────────────────────────────────────────────────────────
  await _auditLog({
    actor:    request.auth.uid,
    action:   suspend ? 'suspendUser' : 'reinstateUser',
    resource: `users/${cleanUid}`,
    details:  {
      uid:    cleanUid,
      email:  targetUser.email || null,
      reason: cleanReason,
      action: suspend ? 'suspended' : 'reinstated',
    },
    severity: 'high',
  });

  return { success: true, uid: cleanUid, suspended: suspend };
});

/* ═══════════════════════════════════════════════════════════════════════════════
   CF 3 — sendPlatformBroadcast
   Creates a platform-wide broadcast message visible to all users matching the
   requested audience segment. A corresponding entry is written to
   `notificationQueue` for async fan-out by a background processor.

   Input  : { title: string, message: string, priority: string, audience: string }
   Returns: { success: true, broadcastId: string }
   Guard  : admin OR superAdmin
═══════════════════════════════════════════════════════════════════════════════ */
exports.sendPlatformBroadcast = onCall({ cors: true, region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, async (request) => {
  _requireAdmin(request);

  const { title, message, priority, audience } = request.data || {};

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!title || typeof title !== 'string') {
    throw new Error('INVALID_ARGUMENT: title is required');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('INVALID_ARGUMENT: message is required');
  }
  if (!priority || !VALID_PRIORITIES.includes(priority)) {
    throw new Error(`INVALID_ARGUMENT: priority must be one of [${VALID_PRIORITIES.join(', ')}]`);
  }
  if (!audience || !VALID_AUDIENCES.includes(audience)) {
    throw new Error(`INVALID_ARGUMENT: audience must be one of [${VALID_AUDIENCES.join(', ')}]`);
  }

  // ── Sanitise — strip HTML to prevent stored XSS ─────────────────────────────
  const cleanTitle   = _stripHtml(title);
  const cleanMessage = _stripHtml(message);

  // ── Length bounds ────────────────────────────────────────────────────────────
  if (cleanTitle.length < 5 || cleanTitle.length > 100) {
    throw new Error('INVALID_ARGUMENT: title must be 5–100 characters after stripping HTML');
  }
  if (cleanMessage.length < 10 || cleanMessage.length > 1000) {
    throw new Error('INVALID_ARGUMENT: message must be 10–1000 characters after stripping HTML');
  }

  const db      = getFirestore();
  const sentBy  = request.auth.uid;
  const sentAt  = FieldValue.serverTimestamp();

  // ── Write broadcast document ─────────────────────────────────────────────────
  const broadcastRef = db.collection('platformBroadcasts').doc();
  const broadcastId  = broadcastRef.id;

  const broadcastDoc = {
    id:             broadcastId,
    title:          cleanTitle,
    message:        cleanMessage,
    priority,
    audience,
    sentBy,
    sentAt,
    deliveryStatus: 'queued',
    deliveredCount: 0,
    failedCount:    0,
  };

  // ── Write notification queue entry for async fan-out ─────────────────────────
  // A background Firestore-triggered or scheduled CF picks this up and fans out
  // to the matched user segments without blocking this call.
  const queueDoc = {
    type:        'platformBroadcast',
    broadcastId,
    title:       cleanTitle,
    message:     cleanMessage,
    priority,
    audience,
    sentBy,
    createdAt:   sentAt,
    status:      'pending',
    attempts:    0,
    nextAttempt: sentAt,
  };

  // Use a batch so both writes are atomic; if one fails, neither persists.
  const batch = db.batch();
  batch.set(broadcastRef, broadcastDoc);
  batch.set(db.collection('notificationQueue').doc(), queueDoc);
  await batch.commit();

  // ── Audit ────────────────────────────────────────────────────────────────────
  await _auditLog({
    actor:    sentBy,
    action:   'sendPlatformBroadcast',
    resource: `platformBroadcasts/${broadcastId}`,
    details:  { broadcastId, title: cleanTitle, priority, audience },
    severity: priority === 'critical' ? 'high' : 'medium',
  });

  return { success: true, broadcastId };
});
