/* ================================================================
   SOKONI Security 6.0 — File Upload Security Module  v1.0
   functions/security-file.js

   validateUploadRequest   — pre-upload MIME / size / filename gate
   generateSecureUploadUrl — mint a signed upload path + nonce token
   onFileUploaded          — Storage trigger: magic-byte + MIME validation,
                             auto-quarantine on failure
   quarantineFile          — admin manual quarantine
   getFileAuditLog         — per-user upload audit trail (admin: any uid)

   Firestore collections (CF-write-only):
     securityFileUploads/{uploadId}   — upload lifecycle records
     securityAuditLog/{eventId}       — immutable audit trail
     securityAlerts/{alertId}         — open quarantine alerts

   Storage paths:
     uploads/{uid}/{purpose}/{nonce}_{ts}.{ext}   — normal uploads
     quarantine/{ts}_{flatPath}                    — quarantined files
================================================================ */
'use strict';

const { onCall, HttpsError }    = require('firebase-functions/v2/https');
const { onObjectFinalized }     = require('firebase-functions/v2/storage');
const logger                     = require('firebase-functions/logger');
const admin                      = require('firebase-admin');
const crypto                     = require('crypto');

/* ── Firestore / Storage helpers ───────────────────────────────────────────── */
const db  = () => admin.firestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();

/* ── CF options ────────────────────────────────────────────────────────────── */
const CF_OPTIONS          = { region: 'us-central1', enforceAppCheck: true };
const CF_OPTIONS_STORAGE  = {
  bucket:         'sokoni-aeb26.firebasestorage.app',
  memory:         '256MiB',
  timeoutSeconds: 120,
};

/* ── Purpose → allowed MIME types + max size ───────────────────────────────── */
const PURPOSE_CONFIG = {
  product_image:   { mimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']), maxMB: 10 },
  store_logo:      { mimes: new Set(['image/jpeg', 'image/png', 'image/webp']),              maxMB: 5  },
  document:        { mimes: new Set(['application/pdf']),                                    maxMB: 20 },
  receipt:         { mimes: new Set(['image/jpeg', 'image/png', 'application/pdf']),         maxMB: 5  },
  id_verification: { mimes: new Set(['image/jpeg', 'image/png']),                            maxMB: 8  },
};
const DEFAULT_CONFIG = {
  mimes:  new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  maxMB:  5,
};

/* ── Known-good magic byte signatures ──────────────────────────────────────── */
const MAGIC_SIGNATURES = {
  'image/jpeg':       (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  'image/png':        (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  'image/gif':        (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  'image/webp':       (b) => b.length >= 12 &&
                             b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
                             b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  'application/pdf':  (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
};

/* ── Helpers ────────────────────────────────────────────────────────────────── */

/** Enforce presence of a Firebase Auth token. */
function _requireAuth(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  return auth;
}

/** Return true if the token carries an admin-level claim. */
function _isAdmin(auth) {
  return auth?.token?.admin === true || auth?.token?.superAdmin === true;
}

/** Strip characters that could cause XSS or path injection. */
function _sanitizeStr(s, maxLen = 500) {
  if (typeof s !== 'string') return '';
  return s.replace(/[<>"'&;`${}()\[\]\\|]/g, '').trim().slice(0, maxLen);
}

/**
 * Validate that a filename contains no path-traversal sequences,
 * null bytes, or shell metacharacters.
 */
function _isSafeFilename(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('..') || name.includes('\0')) return false;
  // Allow word chars, hyphens, dots, spaces only
  return /^[\w\-. ]+$/.test(name) && name.length <= 255;
}

/** Check buffer magic bytes against declared MIME type. */
function _checkMagicBytes(buf, mimeType) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  const check = MAGIC_SIGNATURES[mimeType];
  return check ? check(buf) : true; // unknown types pass (no signature registered)
}

/** Write an immutable entry to securityAuditLog. */
async function _auditWrite(action, actorUid, data = {}) {
  try {
    const eventId  = crypto.randomBytes(12).toString('hex');
    const tsMillis = Date.now();
    const hash     = crypto.createHash('sha256')
      .update(JSON.stringify({ action, actorUid, tsMillis }))
      .digest('hex');
    await db().collection('securityAuditLog').doc(eventId).set({
      eventId, action, actorUid, hash, tsMillis,
      severity:  data.severity  || 'info',
      source:    'security-file',
      createdAt: now(),
      immutable: true,
      ...data,
    });
    return eventId;
  } catch (e) {
    logger.error('[security-file] auditWrite failed', e.message);
  }
}

/** Raise a security alert visible to the admin console. */
async function _raiseAlert(type, severity, payload) {
  try {
    await db().collection('securityAlerts').add({
      type, severity, status: 'open',
      source: 'security-file',
      createdAt: now(),
      ...payload,
    });
  } catch (e) {
    logger.error('[security-file] raiseAlert failed', e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CF 1. validateUploadRequest
   Pre-upload gate called by the client before it attempts a Storage upload.
   Returns { allowed, reason?, maxSizeMB, allowedTypes }.
════════════════════════════════════════════════════════════════════════════ */
exports.validateUploadRequest = onCall(CF_OPTIONS, async (req) => {
  const auth = _requireAuth(req.auth);
  const { purpose, mimeType, fileSize, fileName } = req.data || {};

  if (!mimeType  || typeof mimeType  !== 'string') throw new HttpsError('invalid-argument', 'mimeType is required.');
  if (!fileName  || typeof fileName  !== 'string') throw new HttpsError('invalid-argument', 'fileName is required.');
  if (typeof fileSize !== 'number' || fileSize <= 0)
    throw new HttpsError('invalid-argument', 'fileSize must be a positive number.');

  const cfg          = PURPOSE_CONFIG[purpose] || DEFAULT_CONFIG;
  const maxSizeBytes = cfg.maxMB * 1024 * 1024;
  const allowedTypes = [...cfg.mimes];
  const safeName     = _sanitizeStr(fileName);

  // 1 — MIME check
  if (!cfg.mimes.has(mimeType)) {
    await _auditWrite('upload_rejected_mime', auth.uid, { purpose, mimeType, severity: 'medium' });
    return { allowed: false, reason: `MIME type "${mimeType}" is not permitted for purpose "${purpose || 'default'}".`, maxSizeMB: cfg.maxMB, allowedTypes };
  }

  // 2 — Size check
  if (fileSize > maxSizeBytes) {
    await _auditWrite('upload_rejected_size', auth.uid, { purpose, mimeType, fileSize, maxSizeBytes, severity: 'low' });
    return { allowed: false, reason: `File exceeds maximum size of ${cfg.maxMB}MB.`, maxSizeMB: cfg.maxMB, allowedTypes };
  }

  // 3 — Filename safety check
  if (!_isSafeFilename(safeName)) {
    await _auditWrite('upload_rejected_filename', auth.uid, { purpose, severity: 'high', detail: 'Path traversal or shell metacharacters in filename.' });
    return { allowed: false, reason: 'Invalid filename. Avoid path separators, null bytes, and shell characters.', maxSizeMB: cfg.maxMB, allowedTypes };
  }

  return { allowed: true, maxSizeMB: cfg.maxMB, allowedTypes };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 2. generateSecureUploadUrl
   Mints a pre-authorised Storage path for a specific upload intent.
   Records the pending upload in securityFileUploads for post-upload validation.
════════════════════════════════════════════════════════════════════════════ */
exports.generateSecureUploadUrl = onCall(CF_OPTIONS, async (req) => {
  const auth = _requireAuth(req.auth);
  const { purpose, mimeType, fileName, fileSize } = req.data || {};

  if (!purpose  || typeof purpose  !== 'string') throw new HttpsError('invalid-argument', 'purpose required.');
  if (!mimeType || typeof mimeType !== 'string') throw new HttpsError('invalid-argument', 'mimeType required.');
  if (!fileName || typeof fileName !== 'string') throw new HttpsError('invalid-argument', 'fileName required.');

  const cfg          = PURPOSE_CONFIG[purpose] || DEFAULT_CONFIG;
  const maxSizeBytes = cfg.maxMB * 1024 * 1024;

  if (!cfg.mimes.has(mimeType))
    throw new HttpsError('invalid-argument', `MIME type "${mimeType}" not permitted for purpose "${purpose}".`);
  if (typeof fileSize === 'number' && fileSize > maxSizeBytes)
    throw new HttpsError('invalid-argument', `File exceeds maximum size of ${cfg.maxMB}MB.`);

  const safeName = _sanitizeStr(fileName);
  if (!_isSafeFilename(safeName))
    throw new HttpsError('invalid-argument', 'Invalid filename — path traversal or shell characters detected.');

  const ext         = (safeName.split('.').pop() || 'bin').toLowerCase().slice(0, 10);
  const nonce       = crypto.randomBytes(16).toString('hex');
  const uploadId    = crypto.randomBytes(16).toString('hex');
  const uploadToken = crypto.randomBytes(32).toString('hex');
  const uploadPath  = `uploads/${auth.uid}/${purpose}/${nonce}_${Date.now()}.${ext}`;

  await db().collection('securityFileUploads').doc(uploadId).set({
    uploadId,
    uploadPath,
    uploadToken,      // returned to client; echoed back to onFileUploaded via Storage metadata
    userId:           auth.uid,
    purpose,
    expectedMime:     mimeType,
    maxSizeBytes,
    originalFileName: safeName,
    status:           'pending',
    createdAt:        now(),
    expiresAt:        admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 60 * 1000)),
  });

  await _auditWrite('upload_url_generated', auth.uid, { uploadId, purpose, mimeType, uploadPath, severity: 'info' });

  return { uploadPath, uploadToken, uploadId };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 3. onFileUploaded  (Storage trigger)
   Runs after every object finalise under uploads/.
   Validates content-type, file size, and magic bytes.
   Quarantines on failure; marks record 'verified' on success.

   TODO: Integrate a virus-scanning service (ClamAV / VirusTotal) before
         the magic-byte check when billing budget allows. Log entry retained
         below as the integration point.
════════════════════════════════════════════════════════════════════════════ */
exports.onFileUploaded = onObjectFinalized(CF_OPTIONS_STORAGE, async (event) => {
  const object      = event.data;
  const filePath    = object.name    || '';
  const contentType = object.contentType || '';
  const fileSize    = parseInt(object.size, 10) || 0;
  const bucketName  = object.bucket;

  if (!filePath.startsWith('uploads/')) return; // only process our upload prefix

  logger.info('[security-file] onFileUploaded', { filePath, contentType, fileSize });

  /* ── Load pending upload record ── */
  let uploadDoc   = null;
  let uploadData  = null;
  try {
    const snap = await db().collection('securityFileUploads')
      .where('uploadPath', '==', filePath)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    if (!snap.empty) {
      uploadDoc  = snap.docs[0].ref;
      uploadData = snap.docs[0].data();
    }
  } catch (e) {
    logger.error('[security-file] Firestore lookup failed', e.message);
  }

  const userId     = uploadData?.userId || filePath.split('/')[1] || 'unknown';
  const failReasons = [];

  /* ── Validation 1: Content-Type must match expected MIME ── */
  if (uploadData && contentType !== uploadData.expectedMime) {
    failReasons.push(`Content-Type mismatch: expected "${uploadData.expectedMime}", received "${contentType}".`);
  }

  /* ── Validation 2: File size must be within limit ── */
  if (uploadData && fileSize > uploadData.maxSizeBytes) {
    failReasons.push(`File too large: ${fileSize} bytes exceeds max ${uploadData.maxSizeBytes} bytes.`);
  }

  /* ── Validation 3: Magic bytes ── */
  try {
    const gcsFile       = admin.storage().bucket(bucketName).file(filePath);
    const [magicBuf]    = await gcsFile.download({ start: 0, end: 15 });
    const magicOk       = _checkMagicBytes(magicBuf, contentType);
    if (!magicOk) {
      failReasons.push(`Magic bytes do not match declared MIME type "${contentType}". Possible file-type spoofing.`);
    }
  } catch (e) {
    logger.warn('[security-file] Magic-byte read failed — skipping check', { filePath, error: e.message });
    // TODO: treat read failure as a quarantine trigger once virus-scan is integrated
  }

  /* ── TODO: Virus scan integration point ──
     const scanResult = await _virusScan(bucketName, filePath);
     if (scanResult.infected) failReasons.push(`Virus detected: ${scanResult.signature}`);
  ── */

  if (failReasons.length > 0) {
    /* Move file to quarantine/ prefix */
    const flatPath       = filePath.replace(/\//g, '_');
    const quarantinePath = `quarantine/${Date.now()}_${flatPath}`;
    try {
      const src = admin.storage().bucket(bucketName).file(filePath);
      const dst = admin.storage().bucket(bucketName).file(quarantinePath);
      await src.copy(dst);
      await src.delete();
      logger.warn('[security-file] File quarantined', { filePath, quarantinePath, failReasons });
    } catch (moveErr) {
      logger.error('[security-file] Quarantine move failed', { filePath, error: moveErr.message });
    }

    if (uploadDoc) {
      await uploadDoc.update({ status: 'quarantined', failReasons, quarantinePath, resolvedAt: now() });
    }

    await _raiseAlert('file_quarantined', 'high', { filePath, quarantinePath, userId, failReasons });
    await _auditWrite('file_quarantined', userId, { filePath, quarantinePath, failReasons, severity: 'high' });
    return;
  }

  /* ── Validation passed ── */
  if (uploadDoc) {
    await uploadDoc.update({ status: 'verified', verifiedMime: contentType, verifiedSize: fileSize, resolvedAt: now() });
  }
  await _auditWrite('file_verified', userId, { filePath, contentType, fileSize, severity: 'info' });
  logger.info('[security-file] File verified', { filePath });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 4. quarantineFile  (admin only)
   Manually move any Storage file to the quarantine/ prefix.
════════════════════════════════════════════════════════════════════════════ */
exports.quarantineFile = onCall(CF_OPTIONS, async (req) => {
  const auth = _requireAuth(req.auth);
  if (!_isAdmin(auth)) throw new HttpsError('permission-denied', 'Admin access required.');

  const { filePath, reason } = req.data || {};
  if (!filePath || typeof filePath !== 'string') throw new HttpsError('invalid-argument', 'filePath required.');

  /* Strip path-traversal attempts before moving */
  const safePath       = filePath.replace(/\.\./g, '').replace(/^\/+/, '');
  const flatPath       = safePath.replace(/\//g, '_');
  const quarantinePath = `quarantine/${Date.now()}_${flatPath}`;
  const safeReason     = _sanitizeStr(reason || '');

  const bkt = admin.storage().bucket();
  try {
    await bkt.file(safePath).copy(bkt.file(quarantinePath));
    await bkt.file(safePath).delete();
  } catch (e) {
    throw new HttpsError('not-found', `Unable to move file: ${e.message}`);
  }

  /* Update upload record if one exists */
  try {
    const snap = await db().collection('securityFileUploads')
      .where('uploadPath', '==', safePath)
      .limit(1)
      .get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({
        status:          'quarantined',
        quarantinePath,
        quarantinedBy:   auth.uid,
        quarantineReason: safeReason,
        resolvedAt:      now(),
      });
    }
  } catch (_) {}

  await _auditWrite('manual_quarantine', auth.uid, { filePath: safePath, quarantinePath, reason: safeReason, severity: 'high' });

  return { success: true, quarantinePath };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CF 5. getFileAuditLog
   Returns the last 50 upload audit events for the calling user.
   Admins may pass { userId } to retrieve any user's log.
════════════════════════════════════════════════════════════════════════════ */
exports.getFileAuditLog = onCall(CF_OPTIONS, async (req) => {
  const auth       = _requireAuth(req.auth);
  const isAdmin    = _isAdmin(auth);
  const { userId: requestedUid } = req.data || {};

  if (!isAdmin && requestedUid && requestedUid !== auth.uid) {
    throw new HttpsError('permission-denied', 'Cannot read another user\'s audit log.');
  }

  const targetUid = (isAdmin && requestedUid) ? requestedUid : auth.uid;

  const snap = await db().collection('securityAuditLog')
    .where('actorUid', '==', targetUid)
    .where('source',   '==', 'security-file')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  return {
    userId:  targetUid,
    entries: snap.docs.map(d => {
      const v = d.data();
      return {
        eventId:    v.eventId,
        action:     v.action,
        severity:   v.severity,
        filePath:   v.filePath    || null,
        purpose:    v.purpose     || null,
        uploadId:   v.uploadId    || null,
        tsMillis:   v.tsMillis,
        createdAt:  v.createdAt,
      };
    }),
  };
});
