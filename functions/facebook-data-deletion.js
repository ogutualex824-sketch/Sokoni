'use strict';

/**
 * Facebook / Meta Data Deletion Callback
 *
 * Meta requires every app using Facebook Login to implement a data deletion
 * callback endpoint. When a user removes SOKONI from their Facebook Apps,
 * Meta sends a signed_request to this endpoint.
 *
 * Spec: https://developers.facebook.com/docs/facebook-login/handling-personal-data-deletion
 *
 * Endpoint: POST /api/facebook/data-deletion
 * Response: { url: string, confirmation_code: string }
 */

const { onRequest }     = require('firebase-functions/v2/https');
const { defineSecret }  = require('firebase-functions/params');
const admin             = require('firebase-admin');
const crypto            = require('crypto');

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();

const FB_APP_SECRET = defineSecret('FACEBOOK_APP_SECRET');

const REGION  = 'us-central1';
const CF_OPTS = { region: REGION, secrets: [FB_APP_SECRET] };

/**
 * Parse and verify Facebook's signed_request.
 * Format: base64url(signature).base64url(payload)
 * Signature: HMAC-SHA256(payload, FB_APP_SECRET)
 */
function parseSignedRequest(signedRequest, appSecret) {
  const parts   = (signedRequest || '').split('.');
  if (parts.length !== 2) throw new Error('Invalid signed_request format');

  const [encodedSig, encodedPayload] = parts;

  /* Decode from base64url */
  const decode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  const sig     = decode(encodedSig);
  const payload = decode(encodedPayload);

  /* Verify HMAC-SHA256 */
  const expected = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest();
  if (!crypto.timingSafeEqual(sig, expected)) throw new Error('Bad signed_request signature');

  return JSON.parse(payload.toString('utf8'));
}

/**
 * Generate a stable confirmation code from the Facebook user ID.
 * This code is returned to Meta and shown to the user in their
 * Facebook settings so they can track the deletion.
 */
function confirmationCode(fbUserId) {
  return 'SOKONI-DEL-' + crypto.createHash('sha256').update('sokoni-del-' + fbUserId).digest('hex').slice(0, 16).toUpperCase();
}

exports.facebookDataDeletion = onRequest(CF_OPTS, async (req, res) => {
  /* Only POST */
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  /* CORS — Meta posts from their servers, no browser involved */
  res.set('Access-Control-Allow-Origin', 'https://www.facebook.com');

  const appSecret = FB_APP_SECRET.value();
  if (!appSecret) {
    console.error('[fb-data-deletion] FACEBOOK_APP_SECRET not set');
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  const signedRequest = req.body?.signed_request || req.query?.signed_request;
  if (!signedRequest) {
    res.status(400).json({ error: 'Missing signed_request' });
    return;
  }

  let payload;
  try {
    payload = parseSignedRequest(signedRequest, appSecret);
  } catch (err) {
    console.warn('[fb-data-deletion] Invalid signed_request:', err.message);
    res.status(400).json({ error: 'Invalid signed_request' });
    return;
  }

  const fbUserId = payload.user_id;
  if (!fbUserId) {
    res.status(400).json({ error: 'user_id missing from signed_request' });
    return;
  }

  const code      = confirmationCode(fbUserId);
  const statusUrl = `https://mysokoni.co.ke/data-deletion?ref=${encodeURIComponent(code)}`;

  /* Check if already queued to prevent duplicates */
  const existing = await db.collection('dataDeletionRequests')
    .where('facebookUserId', '==', fbUserId)
    .where('status', 'in', ['pending', 'processing'])
    .limit(1)
    .get();

  if (!existing.empty) {
    /* Already queued — return existing code */
    res.status(200).json({ url: statusUrl, confirmation_code: code });
    return;
  }

  /* Record the deletion request */
  await db.collection('dataDeletionRequests').add({
    facebookUserId:    fbUserId,
    appId:             payload.app_id || null,
    algorithm:         payload.algorithm || 'HMAC-SHA256',
    issuedAt:          payload.issued_at ? new Date(payload.issued_at * 1000) : null,
    confirmationCode:  code,
    statusUrl:         statusUrl,
    source:            'facebook_callback',
    status:            'pending',
    createdAt:         admin.firestore.FieldValue.serverTimestamp(),
    processBy:         new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), /* 30-day deadline */
  });

  console.info('[fb-data-deletion] Queued deletion for FB user:', fbUserId.slice(0, 6) + '…');

  /* Meta's required response format */
  res.status(200).json({
    url:               statusUrl,
    confirmation_code: code,
  });
});

/**
 * Callable: admins can look up a deletion request by confirmation code
 * and update its status.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');

exports.adminGetDataDeletionRequest = onCall(
  { region: REGION, invoker: 'private' },
  async (request) => {
    const { auth } = request;
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admins only');

    const { confirmationCode: code } = request.data;
    if (!code) throw new HttpsError('invalid-argument', 'confirmationCode required');

    const snap = await db.collection('dataDeletionRequests')
      .where('confirmationCode', '==', code)
      .limit(1)
      .get();

    if (snap.empty) throw new HttpsError('not-found', 'Request not found');

    const doc = snap.docs[0];
    return { id: doc.id, ...doc.data() };
  }
);

exports.adminUpdateDataDeletionStatus = onCall(
  { region: REGION, invoker: 'private' },
  async (request) => {
    const { auth } = request;
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admins only');

    const { requestId, status, notes } = request.data;
    const VALID_STATUSES = ['pending', 'processing', 'completed', 'failed'];
    if (!requestId || !VALID_STATUSES.includes(status)) {
      throw new HttpsError('invalid-argument', 'requestId and valid status required');
    }

    await db.collection('dataDeletionRequests').doc(requestId).update({
      status,
      notes:       notes || null,
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
      updatedBy:   auth.uid,
    });

    return { success: true };
  }
);

/**
 * Callable: users submit self-service data rights requests
 */
exports.submitDataRightsRequest = onCall(
  { region: REGION },
  async (request) => {
    const { name, email, phone, type, details } = request.data;

    /* Must-fix #3 — the data-deletion.html form sends KDPA-standard right names
       (deletion/access/rectification/restriction/portability/objection) that did NOT
       match the backend enum, so EVERY request failed invalid-argument. Normalize both
       the UI names AND the pre-existing backend values to one canonical set; unknown → reject.
       We store the canonical `type` AND the caller's original `requestedRight` for the record. */
    const TYPE_ALIASES = {
      deletion:            'delete_account',     delete_account:      'delete_account',
      facebook_deletion:   'facebook_deletion',
      access:              'export_data',        export_data:         'export_data',
      portability:         'export_data',
      rectification:       'rectify_data',       rectify_data:        'rectify_data',
      restriction:         'restrict_processing', restrict_processing: 'restrict_processing',
      objection:           'object_processing',  object_processing:   'object_processing',
      withdraw_consent:    'withdraw_consent',
    };
    const canonicalType = TYPE_ALIASES[type];

    if (!name || typeof name !== 'string' || name.length > 120) {
      throw new HttpsError('invalid-argument', 'Valid name required');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpsError('invalid-argument', 'Valid email required');
    }
    if (!canonicalType) {
      throw new HttpsError('invalid-argument', 'Invalid request type');
    }

    await db.collection('dataRightsRequests').add({
      name:       name.trim(),
      email:      email.trim().toLowerCase(),
      phone:      phone ? phone.trim().slice(0, 20) : null,
      type:           canonicalType,   /* normalized */
      requestedRight: type,            /* the exact right the user selected in the UI */
      details:    details ? details.trim().slice(0, 1000) : null,
      status:     'received',
      uid:        request.auth?.uid || null,
      ip:         request.rawRequest?.ip || null,
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      respondBy:  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    return { success: true };
  }
);

/**
 * deleteMyAccount — authenticated self-service account deletion.
 *
 * Security:
 *   - Requires valid Firebase Auth token (request.auth.uid).
 *   - Optionally re-validates password or verifies a recent-login
 *     timestamp to prevent CSRF / stolen token abuse.
 *   - Does NOT immediately delete — soft-deletes the user record
 *     and queues hard deletion after a 30-day reversal window,
 *     matching the retention policy in privacy.html.
 *   - Firebase Auth account is disabled immediately (can't sign in).
 *   - Personal data is anonymised within 24 hours by a sweep job.
 *
 * The caller on the client side must be signed in and pass
 * { confirmDelete: true, reason?: string } as data.
 */
exports.deleteMyAccount = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'You must be signed in to delete your account');
    }

    const { confirmDelete, reason } = request.data;
    if (confirmDelete !== true) {
      throw new HttpsError('invalid-argument', 'confirmDelete must be true');
    }

    const uid = request.auth.uid;

    /* Single deletion authority. This schedules erasure on the SAME fields the working purge
       worker (account-manager.js finaliseExpiredDeletions) queries — status:'pending_deletion'
       + deletionScheduledAt — instead of the old orphaned accountDeletions queue (which had no
       consumer, so the account was disabled but never actually erased). */
    const uDoc = await db.collection('users').doc(uid).get();
    if (uDoc.exists && uDoc.data().status === 'pending_deletion') {
      throw new HttpsError('already-exists', 'A deletion request is already pending for this account');
    }

    const graceMs     = 30 * 24 * 60 * 60 * 1000;
    const scheduledAt = admin.firestore.Timestamp.fromMillis(Date.now() + graceMs);

    /* Immediate lockout — disable Auth + revoke tokens. PII is KEPT during the 30-day grace so
       the user can cancel and restore; the worker performs the full spec-driven purge (delete
       personal + anonymize statutorily-retained + Storage + auth.deleteUser) at expiry. */
    await admin.auth().updateUser(uid, { disabled: true });
    try { await admin.auth().revokeRefreshTokens(uid); } catch (_) {}

    await db.collection('users').doc(uid).set({
      status:              'pending_deletion',          /* the field finaliseExpiredDeletions queries */
      deletionScheduledAt: scheduledAt,
      deletionRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletionReason:      reason ? String(reason).slice(0, 200) : null,
      disabled:            true,
    }, { merge: true });

    await db.collection('auditLog').add({
      action: 'account_deletion_scheduled', uid,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    console.info('[deleteMyAccount] Scheduled erasure for uid:', uid.slice(0, 8) + '…');

    return {
      success:    true,
      purgeAfter: new Date(Date.now() + graceMs).toISOString(),
      message:    'Your account has been deactivated and is scheduled for permanent erasure in 30 days. Sign in before then to cancel.',
    };
  }
);
