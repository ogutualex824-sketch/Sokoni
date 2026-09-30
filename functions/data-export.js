'use strict';

/**
 * Data Portability — GDPR Art. 20 / Kenya Data Protection Act §26
 *
 * functions/data-export.js
 *
 * Implements the right to data portability for every authenticated SOKONI user.
 * Three Cloud Functions are exported:
 *
 *   requestDataExport    (onCall)              — rate-limited (1/24 h); queues export job
 *   getDataExportStatus  (onCall)              — poll or retrieve the download URL
 *   processDataExport    (onDocumentCreated)   — background worker; builds + uploads JSON
 *
 * Firestore collections used (server-side writes only — no client security rules needed):
 *   dataExportRequests/{requestId}   — user-facing status record
 *   dataExportQueue/{requestId}      — internal trigger document for the background worker
 *
 * Storage layout (private; accessible only via time-limited signed URL):
 *   data-exports/{uid}/{requestId}.json
 *
 * Security notes:
 *   - enforceAppCheck: true on all onCall functions
 *   - uid ownership verified before every read
 *   - Signed URLs expire after 7 days, matching the request expiry
 *   - No payment card numbers, raw passwords, or HMAC keys are ever included
 */

const { onCall, HttpsError }   = require('firebase-functions/v2/https');
const { onDocumentCreated }    = require('firebase-functions/v2/firestore');
const { Timestamp } = require('firebase-admin/firestore');
const admin         = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

// ── Constants ──────────────────────────────────────────────────────────────

const REGION          = 'us-central1';
const RATE_LIMIT_MS   = 24 * 60 * 60 * 1000;   // 24 hours in milliseconds
const EXPORT_TTL_MS   = 7  * 24 * 60 * 60 * 1000; // 7 days in milliseconds
const SIGNED_URL_MS   = 7  * 24 * 60 * 60 * 1000; // signed URL lifetime matches TTL

/** Fields that must never appear in an exported document — stripped by sanitizeDoc(). */
const BLOCKED_FIELDS = new Set([
  'password', 'passwordHash', 'salt',
  'cardNumber', 'cvv', 'pan',
  'hmacKey', 'hmacSecret',
  'rawSecret', 'privateKey',
]);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return a lazy Firestore instance.
 * Using admin.firestore() directly keeps this module compatible with the
 * single admin.initializeApp() call in index.js.
 */
function db() {
  return admin.firestore();
}

/**
 * Return the default Storage bucket.
 */
function bucket() {
  return admin.storage().bucket();
}

/**
 * Structured logger — prefixes every message with severity and function context.
 * @param {string} fn  — function name tag for log correlation
 * @returns {{ info, warn, error, audit }}
 */
function logger(fn) {
  const tag = `[data-export:${fn}]`;
  return {
    info:  (msg, extra = {}) => console.log(JSON.stringify({ severity: 'INFO',    message: `${tag} ${msg}`, ...extra })),
    warn:  (msg, extra = {}) => console.warn(JSON.stringify({ severity: 'WARNING', message: `${tag} ${msg}`, ...extra })),
    error: (msg, extra = {}) => console.error(JSON.stringify({ severity: 'ERROR',  message: `${tag} ${msg}`, ...extra })),
    audit: (msg, extra = {}) => console.log(JSON.stringify({ severity: 'NOTICE',  message: `${tag} ${msg}`, ...extra, audit: true })),
  };
}

/**
 * Strip blocked fields and trim all string values in a plain object or array.
 * Operates recursively so nested sub-documents are also sanitized.
 * Does NOT perform HTML encoding — output is a JSON download, not HTML.
 *
 * @param {*} value — any JSON-serialisable value
 * @returns sanitized clone
 */
function sanitizeDoc(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeDoc);
  }
  if (value !== null && typeof value === 'object') {
    // Convert Firestore Timestamps and Date instances to ISO strings
    if (value instanceof Date) return value.toISOString();
    if (typeof value.toDate === 'function') return value.toDate().toISOString();

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (BLOCKED_FIELDS.has(k)) continue; // silently drop sensitive fields
      out[k] = sanitizeDoc(v);
    }
    return out;
  }
  if (typeof value === 'string') return value.trim();
  return value;
}

/**
 * Fetch all documents from a collection query and return as a sanitized array.
 * Errors are caught and logged — a single collection failure does not abort the export.
 *
 * @param {FirebaseFirestore.Query} query
 * @param {string} label — used in error logging
 * @returns {Promise<object[]>}
 */
async function fetchCollection(query, label) {
  const log = logger('fetchCollection');
  try {
    const snap = await query.get();
    return snap.docs.map(d => sanitizeDoc({ _id: d.id, ...d.data() }));
  } catch (err) {
    log.warn(`Failed to fetch ${label}`, { error: err.message });
    return []; // partial export — continue with other collections
  }
}

// ── Exported Cloud Functions ───────────────────────────────────────────────

/**
 * requestDataExport
 *
 * Callable (enforceAppCheck: true, authenticated).
 * Rate-limited to one export request per user per 24 hours.
 *
 * If the user already has a pending or ready export from the past 7 days,
 * returns the existing request status instead of creating a new one.
 *
 * Returns: { requestId, status, message }
 */
exports.requestDataExport = onCall(
  { region: REGION, enforceAppCheck: true },
  async (request) => {
    const log = logger('requestDataExport');

    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'You must be signed in to request a data export.');
    }

    const uid = request.auth.uid;
    const firestore = db();
    const now = Date.now();

    // ── Rate-limit check: reject if a request was made in the last 24 hours ──
    const recentSnap = await firestore.collection('dataExportRequests')
      .where('uid', '==', uid)
      .where('status', 'in', ['pending', 'processing', 'ready'])
      .orderBy('requestedAt', 'desc')
      .limit(1)
      .get();

    if (!recentSnap.empty) {
      const existing = recentSnap.docs[0];
      const existingData = existing.data();
      const requestedAt = existingData.requestedAt?.toMillis?.() ?? 0;

      // Within the 24-hour window — return the existing request
      if (now - requestedAt < RATE_LIMIT_MS) {
        log.info('Returning existing export request', { uid: uid.slice(0, 8) + '…', requestId: existing.id });
        return {
          requestId: existing.id,
          status:    existingData.status,
          message:   existingData.status === 'ready'
            ? 'Your data export is ready for download.'
            : 'Your data export is already being prepared. Please check back shortly.',
        };
      }
    }

    // ── Create new export request ──────────────────────────────────────────
    const requestedAt = Timestamp.now();
    const expiresAt   = Timestamp.fromMillis(now + EXPORT_TTL_MS);

    const payload = {
      uid,
      status:      'pending',
      requestedAt,
      expiresAt,
    };

    // Write the user-facing status record first
    const requestRef = await firestore.collection('dataExportRequests').add(payload);
    const requestId  = requestRef.id;

    // Write the queue trigger document — this fires processDataExport
    await firestore.collection('dataExportQueue').doc(requestId).set(payload);

    log.audit('Data export requested', { uid: uid.slice(0, 8) + '…', requestId });

    return {
      requestId,
      status:  'pending',
      message: 'Your data export is being prepared. This may take a few minutes. Check back using your request ID.',
    };
  }
);

/**
 * getDataExportStatus
 *
 * Callable (enforceAppCheck: true, authenticated).
 * Input: { requestId: string }
 *
 * Verifies ownership before returning status.
 *
 * Returns: { requestId, status, downloadUrl?, expiresAt }
 */
exports.getDataExportStatus = onCall(
  { region: REGION, enforceAppCheck: true },
  async (request) => {
    const log = logger('getDataExportStatus');

    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'You must be signed in to check export status.');
    }

    const uid = request.auth.uid;
    const { requestId } = request.data ?? {};

    if (!requestId || typeof requestId !== 'string' || requestId.length > 128) {
      throw new HttpsError('invalid-argument', 'A valid requestId is required.');
    }

    const snap = await db().collection('dataExportRequests').doc(requestId).get();

    if (!snap.exists) {
      throw new HttpsError('not-found', 'Export request not found.');
    }

    const data = snap.data();

    // ── Ownership check — users can only see their own exports ─────────────
    if (data.uid !== uid) {
      // Return not-found to avoid leaking existence of other users' exports
      log.warn('Ownership mismatch on export status check', { uid: uid.slice(0, 8) + '…', requestId });
      throw new HttpsError('not-found', 'Export request not found.');
    }

    const response = {
      requestId,
      status:    data.status,
      expiresAt: data.expiresAt?.toDate?.()?.toISOString() ?? null,
    };

    if (data.status === 'ready' && data.downloadUrl) {
      response.downloadUrl = data.downloadUrl;
    }

    return response;
  }
);

/**
 * processDataExport
 *
 * Firestore trigger — fires when a new document is created in dataExportQueue/{requestId}.
 * This is a server-to-server operation; it does not accept client input.
 *
 * Workflow:
 *   1. Read queue document to get uid + requestId
 *   2. Update status to 'processing'
 *   3. Collect user data from all relevant collections
 *   4. Upload sanitized JSON to Cloud Storage
 *   5. Generate a 7-day signed URL
 *   6. Update dataExportRequests/{requestId} to { status: 'ready', downloadUrl, completedAt }
 *   7. On any error: set status = 'failed'
 */
exports.processDataExport = onDocumentCreated(
  { document: 'dataExportQueue/{requestId}', region: REGION },
  async (event) => {
    const log = logger('processDataExport');

    const queueDoc = event.data?.data();
    if (!queueDoc) {
      log.error('Queue document is empty — skipping');
      return;
    }

    const { uid } = queueDoc;
    const requestId = event.params.requestId;

    if (!uid || typeof uid !== 'string') {
      log.error('Invalid uid in queue document', { requestId });
      return;
    }

    const firestore  = db();
    const requestRef = firestore.collection('dataExportRequests').doc(requestId);

    // ── Mark as processing ─────────────────────────────────────────────────
    try {
      await requestRef.update({ status: 'processing' });
    } catch (err) {
      log.error('Failed to mark request as processing', { requestId, error: err.message });
      return; // If we can't even update status, bail — avoid orphaned jobs
    }

    log.info('Starting data collection', { uid: uid.slice(0, 8) + '…', requestId });

    try {
      // ── Collect all user data ──────────────────────────────────────────
      const firestore = db();

      const [
        profileSnap,
        orders,
        walletSnap,
        walletTransactions,
        reviews,
        jobApplications,
        notifications,
        loyaltySnap,
      ] = await Promise.all([
        // users/{uid} — profile document
        firestore.collection('users').doc(uid).get().then(d =>
          d.exists ? sanitizeDoc({ _id: d.id, ...d.data() }) : null
        ).catch(err => { log.warn('Failed to fetch user profile', { error: err.message }); return null; }),

        // orders — last 100 where buyerUid == uid
        fetchCollection(
          firestore.collection('orders')
            .where('buyerUid', '==', uid)
            .orderBy('createdAt', 'desc')
            .limit(100),
          'orders'
        ),

        // wallets/{uid} — balance document
        firestore.collection('wallets').doc(uid).get().then(d =>
          d.exists ? sanitizeDoc({ _id: d.id, ...d.data() }) : null
        ).catch(err => { log.warn('Failed to fetch wallet', { error: err.message }); return null; }),

        // walletTransactions — last 100 where uid == uid
        fetchCollection(
          firestore.collection('walletTransactions')
            .where('uid', '==', uid)
            .orderBy('createdAt', 'desc')
            .limit(100),
          'walletTransactions'
        ),

        // reviews — last 50 authored by this user
        fetchCollection(
          firestore.collection('reviews')
            .where('authorUid', '==', uid)
            .orderBy('createdAt', 'desc')
            .limit(50),
          'reviews'
        ),

        // jobApplications — last 50 submitted by this user
        fetchCollection(
          firestore.collection('jobApplications')
            .where('seekerUid', '==', uid)
            .orderBy('appliedAt', 'desc')
            .limit(50),
          'jobApplications'
        ),

        // notifications — last 50 for this user
        fetchCollection(
          firestore.collection('notifications')
            .where('recipientUid', '==', uid)
            .orderBy('createdAt', 'desc')
            .limit(50),
          'notifications'
        ),

        // loyaltyPoints/{uid} — points and tier document
        firestore.collection('loyaltyPoints').doc(uid).get().then(d =>
          d.exists ? sanitizeDoc({ _id: d.id, ...d.data() }) : null
        ).catch(err => { log.warn('Failed to fetch loyalty points', { error: err.message }); return null; }),
      ]);

      // ── Build the export package ───────────────────────────────────────
      const exportPayload = {
        exportMetadata: {
          exportedAt:    new Date().toISOString(),
          requestId,
          legalBasis:    'GDPR Article 20 / Kenya Data Protection Act Section 26',
          platform:      'SOKONI',
          dataSubjectUid: uid,
        },
        profile:            profileSnap,
        wallet:             walletSnap,
        loyaltyPoints:      loyaltySnap,
        orders,
        walletTransactions,
        reviews,
        jobApplications,
        notifications,
      };

      const jsonBuffer = Buffer.from(JSON.stringify(exportPayload, null, 2), 'utf8');

      // ── Upload to Cloud Storage ────────────────────────────────────────
      // Path: data-exports/{uid}/{requestId}.json
      // Access: private — no public read; access only via signed URL
      const storagePath = `data-exports/${uid}/${requestId}.json`;
      const file        = bucket().file(storagePath);

      await file.save(jsonBuffer, {
        contentType: 'application/json; charset=utf-8',
        resumable:   false,
        metadata: {
          cacheControl:        'private, no-cache',
          contentDisposition:  `attachment; filename="${requestId}.json"`,
          // Custom metadata for auditing — not exposed to end users
          exportRequestId: requestId,
          dataSubjectUid:  uid,
        },
      });

      // ── Generate a 7-day signed URL ────────────────────────────────────
      const expiresDate = new Date(Date.now() + SIGNED_URL_MS);
      const [downloadUrl] = await file.getSignedUrl({
        action:  'read',
        expires: expiresDate,
      });

      // ── Mark request as ready ──────────────────────────────────────────
      await requestRef.update({
        status:      'ready',
        downloadUrl,
        completedAt: Timestamp.now(),
      });

      log.audit('Data export completed', {
        uid:         uid.slice(0, 8) + '…',
        requestId,
        storagePath,
        expiresAt:   expiresDate.toISOString(),
      });

    } catch (err) {
      // ── Failure — record the error and flip status to 'failed' ─────────
      log.error('Data export failed', { requestId, error: err.message, stack: err.stack });

      try {
        /* Record WHY, not just THAT it failed.
           Previously this wrote only {status,failedAt}: the raw cause went to
           Cloud Logging and nothing reached the document, so a data-subject
           request failed opaquely — the user saw "failed" with no explanation
           and support could not diagnose it without log access. That is poor
           for any job and materially worse for a GDPR right-of-access request.

           Two fields, deliberately separated:
           • failureReason — SAFE, generic, user-facing. Never the raw error, so
             internal implementation details are not exposed (see the error
             handling standard: meaningful errors, no internals to end users).
           • failureCode — short, stable, for support/ops correlation with the
             Cloud Logging entry above, which still holds the full message. */
        const raw = String(err && err.message || '');
        const failureCode =
          /storage|bucket|upload/i.test(raw)      ? 'storage_unavailable'
          : /permission|denied|iam/i.test(raw)    ? 'permission_denied'
          : /quota|resource-exhausted|limit/i.test(raw) ? 'quota_exceeded'
          : /timeout|deadline/i.test(raw)         ? 'timed_out'
          : /not found|no such|missing/i.test(raw) ? 'source_data_missing'
          : 'internal_error';

        await requestRef.update({
          status:        'failed',
          failedAt:      Timestamp.now(),
          failureCode,
          failureReason: 'We could not complete your data export. Please request it '
                       + 'again; if it keeps failing, contact support with this request ID.',
        });
      } catch (updateErr) {
        // If even the status update fails, log and give up — do not throw
        log.error('Could not update request to failed status', {
          requestId,
          error: updateErr.message,
        });
      }
    }
  }
);
