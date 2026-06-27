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

    const VALID_TYPES = [
      'delete_account', 'export_data', 'rectify_data',
      'restrict_processing', 'withdraw_consent', 'facebook_deletion',
    ];

    if (!name || typeof name !== 'string' || name.length > 120) {
      throw new HttpsError('invalid-argument', 'Valid name required');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpsError('invalid-argument', 'Valid email required');
    }
    if (!VALID_TYPES.includes(type)) {
      throw new HttpsError('invalid-argument', 'Invalid request type');
    }

    await db.collection('dataRightsRequests').add({
      name:       name.trim(),
      email:      email.trim().toLowerCase(),
      phone:      phone ? phone.trim().slice(0, 20) : null,
      type,
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
