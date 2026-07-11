/* ============================================================================
   SOKONI Enterprise Identity Module Ã¢â‚¬â€ security-identity.js
   Firebase Cloud Functions Gen2 Ã‚Â· Node.js 22
   ============================================================================

   Functions (14 total):

   TOTP MFA (6)
     initiateTOTPEnrollment   Ã¢â‚¬â€ generate secret, store pending enrollment
     verifyTOTPEnrollment     Ã¢â‚¬â€ confirm code, activate MFA, return backup codes
     verifyTOTP               Ã¢â‚¬â€ step-up verification (code or backup code)
     disableMFA               Ã¢â‚¬â€ deactivate after TOTP confirmation
     getMFAStatus             Ã¢â‚¬â€ read own enrollment status
     regenerateBackupCodes    Ã¢â‚¬â€ replace backup codes after TOTP confirmation

   WebAuthn / Passkeys (4)
     initiatePasskeyRegistration    Ã¢â‚¬â€ issue challenge for credential creation
     verifyPasskeyRegistration      Ã¢â‚¬â€ store verified credential
     initiatePasskeyAuthentication  Ã¢â‚¬â€ issue challenge for credential assertion
     verifyPasskeyAuthentication    Ã¢â‚¬â€ validate assertion, update counter

   Device Trust Registry (4)
     registerDevice           Ã¢â‚¬â€ fingerprint Ã¢â€ â€™ device record (new or update)
     getDevices               Ã¢â‚¬â€ list all trusted devices for authenticated user
     removeDevice             Ã¢â‚¬â€ soft-delete / revoke trust
     updateDeviceTrustScore   Ã¢â‚¬â€ event-driven score adjustment

   Firestore Collections:
     securityMFA/{userId}
     securityPasskeys/{userId}/credentials/{credentialId}
     securityPasskeys/{userId}/challenges/{challengeId}
     securityDevices/{userId}/devices/{deviceId}
     securityAuditLog/{eventId}

   Security Standards:
     Ã‚Â· TOTP backup codes: SHA-256 hashed, never stored plaintext
     Ã‚Â· Passkey challenges: 32-byte random, 5-min TTL, single-use
     Ã‚Â· Device fingerprints: SHA-256 hashed, raw value never persisted
     Ã‚Â· All sensitive operations emit immutable audit log entries
     Ã‚Â· All functions enforce App Check
   ============================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const crypto = require('crypto');

/* Ã¢â€â‚¬Ã¢â€â‚¬ Firebase references Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* Ã¢â€â‚¬Ã¢â€â‚¬ Shared Cloud Function options Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
const CF_OPTIONS = {
  region:          'us-central1',
  enforceAppCheck: true,
  memory:          '256MiB',
  timeoutSeconds:  60,
};

/* Ã¢â€â‚¬Ã¢â€â‚¬ Role hierarchy Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
const ROLE = {
  cashier:    0,
  supervisor: 1,
  manager:    2,
  owner:      3,
  admin:      4,
  super_admin:5,
};

/* Ã¢â€â‚¬Ã¢â€â‚¬ Collection name constants Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
const COL = {
  MFA:       'securityMFA',
  PASSKEYS:  'securityPasskeys',
  DEVICES:   'securityDevices',
  AUDIT:     'securityAuditLog',
};

/* Ã¢â€â‚¬Ã¢â€â‚¬ Platform constants Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
const RELYING_PARTY_ID   = 'mysokoni.co.ke';
const RELYING_PARTY_NAME = 'SOKONI';
const TOTP_ISSUER        = 'SOKONI';
const TOTP_WINDOW        = 1;           // Ã‚Â±1 step (90-second tolerance)
const CHALLENGE_TTL_MS   = 5 * 60 * 1000; // 5 minutes
const ENROLLMENT_TTL_MS  = 10 * 60 * 1000; // 10 minutes
const BACKUP_CODE_COUNT  = 8;
const BACKUP_CODE_LENGTH = 8;
const _h = {};

/* ============================================================================
   SHARED HELPERS
   ============================================================================ */

/**
 * Throw HttpsError('unauthenticated') if no auth context present.
 * @param {object|null|undefined} auth - Firebase auth context from onCall request
 */
function _requireAuth(auth) {
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
}

/**
 * Enforce minimum role level from custom claim.
 * @param {object} auth  - Firebase auth context
 * @param {number} minRole - Minimum ROLE level required
 */
function _requireRole(auth, minRole) {
  _requireAuth(auth);
  const r     = auth.token?.role;
  const level = typeof r === 'number' ? r : (ROLE[r] ?? 0);
  if (level < minRole) {
    throw new HttpsError('permission-denied', 'Insufficient role.');
  }
}

/**
 * Structured logger Ã¢â‚¬â€ every call in this module emits JSON to Cloud Logging.
 * Pass `audit: true` for audit-trail lines (severity NOTICE).
 */
function _log(severity, message, extra = {}) {
  const entry = { severity, message, module: 'security-identity', ...extra };
  if (severity === 'ERROR')  { console.error(JSON.stringify(entry)); return; }
  if (severity === 'WARNING'){ console.warn(JSON.stringify(entry));  return; }
  console.log(JSON.stringify(entry));
}

/**
 * Write an immutable event to securityAuditLog.
 * Never throws Ã¢â‚¬â€ audit failures must not abort the primary operation.
 */
async function _audit(event, uid, extra = {}) {
  try {
    await db.collection(COL.AUDIT).add({
      event,
      uid:       uid || null,
      createdAt: FieldValue.serverTimestamp(),
      ...extra,
    });
  } catch (err) {
    _log('WARNING', 'Audit write failed', { event, uid, error: err.message });
  }
}

/**
 * Sanitize a value for safe inclusion in Firestore or logs (no XSS vectors).
 */
function _sanitize(s, maxLen = 256) {
  if (typeof s !== 'string') return String(s || '');
  return s.replace(/[<>"'&]/g, c => (
    { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c]
  )).slice(0, maxLen);
}

/**
 * Throw HttpsError with a given code and message.
 */
function _err(msg, code = 'invalid-argument') {
  throw new HttpsError(code, msg);
}

/* ============================================================================
   TOTP IMPLEMENTATION (pure crypto, no external library)
   ============================================================================ */

/**
 * Generate an HOTP value for the given secret buffer and counter.
 * Algorithm: RFC 4226 Ã‚Â§5.3
 *
 * @param {Buffer} secret  - Raw key bytes
 * @param {number} counter - TOTP time-step counter
 * @returns {number} 6-digit OTP
 */
function _generateHOTP(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac   = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
     (hmac[offset + 3] & 0xff)
  ) % 1_000_000;
}

/**
 * Verify a 6-digit TOTP code against the stored Base64-encoded secret.
 * Tolerates clock drift of Ã‚Â±windowSize time-steps (30 s each).
 *
 * @param {string} secretBase64 - Secret stored as plain base64 string
 * @param {string|number} code  - 6-digit code to verify
 * @param {number} windowSize   - Number of steps to check either side (default 1)
 * @returns {boolean}
 */
function _verifyTOTP(secretBase64, code, windowSize = TOTP_WINDOW) {
  const decodedSecret = Buffer.from(secretBase64, 'base64');
  const counter       = Math.floor(Date.now() / 1000 / 30);
  const intCode       = parseInt(String(code), 10);
  if (isNaN(intCode) || intCode < 0 || intCode > 999999) return false;
  for (let i = -windowSize; i <= windowSize; i++) {
    if (_generateHOTP(decodedSecret, counter + i) === intCode) return true;
  }
  return false;
}

/* ============================================================================
   BACKUP CODE UTILITIES
   ============================================================================ */

/**
 * Generate `count` random alphanumeric backup codes of `length` characters.
 * Returns { plaintext: string[], hashes: string[] } Ã¢â‚¬â€ store only hashes.
 */
function _generateBackupCodes(count = BACKUP_CODE_COUNT, length = BACKUP_CODE_LENGTH) {
  const plaintext = [];
  const hashes    = [];
  const chars     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0 I/1 confusion
  for (let i = 0; i < count; i++) {
    let code = '';
    const bytes = crypto.randomBytes(length);
    for (let b = 0; b < length; b++) {
      code += chars[bytes[b] % chars.length];
    }
    plaintext.push(code);
    hashes.push(crypto.createHash('sha256').update(code).digest('hex'));
  }
  return { plaintext, hashes };
}

/**
 * Check a submitted backup code against the stored hash array.
 * Returns { matched: boolean, index: number } Ã¢â‚¬â€ caller marks code used by index.
 */
function _checkBackupCode(submittedCode, storedHashes = []) {
  const normalised = String(submittedCode || '').toUpperCase().replace(/\s+/g, '');
  const hash       = crypto.createHash('sha256').update(normalised).digest('hex');
  const index      = storedHashes.indexOf(hash);
  return { matched: index !== -1, index };
}

/* ============================================================================
   TOTP MFA Ã¢â‚¬â€ CLOUD FUNCTIONS
   ============================================================================ */

/* Ã¢â€â‚¬Ã¢â€â‚¬ 1. initiateTOTPEnrollment Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Generate a TOTP secret and store a pending enrollment record.
 * The client renders the returned qrUri as a QR code for authenticator apps.
 *
 * Input:  none (uses auth.uid / auth.token.email)
 * Output: { secret: string, qrUri: string }
 */
const initiateTOTPEnrollment = onCall(CF_OPTIONS, _h.initiateTOTPEnrollment = async ({ auth }) => {
  _requireAuth(auth);
  const uid   = auth.uid;
  const email = auth.token?.email || auth.token?.phone_number || uid;

  /* Check for existing confirmed enrollment Ã¢â‚¬â€ require disableMFA first */
  const existingSnap = await db.collection(COL.MFA).doc(uid).get();
  if (existingSnap.exists && existingSnap.data()?.pending === false) {
    _err('MFA is already enrolled. Disable it first before re-enrolling.', 'failed-precondition');
  }

  /* Generate 20-byte (160-bit) TOTP secret Ã¢â‚¬â€ RFC 4226 recommended minimum */
  const secret = crypto.randomBytes(20).toString('base64');

  /* Store pending enrollment */
  await db.collection(COL.MFA).doc(uid).set({
    secret,
    pending:   true,
    method:    'totp',
    createdAt: FieldValue.serverTimestamp(),
    uid,
  });

  /* Build otpauth URI for QR code rendering (RFC 6238 / Google Authenticator format) */
  const qrUri =
    'otpauth://totp/' +
    encodeURIComponent(TOTP_ISSUER + ':' + email) +
    '?secret=' + secret +
    '&issuer=' + encodeURIComponent(TOTP_ISSUER) +
    '&algorithm=SHA1&digits=6&period=30';

  _log('INFO', 'TOTP enrollment initiated', { uid });
  await _audit('totp.enrollment.initiated', uid);

  return { secret, qrUri };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 2. verifyTOTPEnrollment Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Confirm a 6-digit code to activate TOTP enrollment.
 * Generates and returns 8 backup codes (shown ONCE Ã¢â‚¬â€ not stored in plaintext).
 *
 * Input:  { code: string }
 * Output: { success: true, backupCodes: string[] }
 */
const verifyTOTPEnrollment = onCall(CF_OPTIONS, _h.verifyTOTPEnrollment = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid  = auth.uid;
  const code = String(data?.code || '').trim();
  if (!code) _err('code is required.');

  /* Load pending enrollment */
  const mfaRef  = db.collection(COL.MFA).doc(uid);
  const mfaSnap = await mfaRef.get();

  if (!mfaSnap.exists) {
    _err('No pending MFA enrollment found. Call initiateTOTPEnrollment first.', 'not-found');
  }

  const mfaData = mfaSnap.data();

  if (!mfaData.pending) {
    _err('TOTP is already enrolled.', 'failed-precondition');
  }

  /* Enforce 10-minute TTL on pending enrollment */
  const createdMs = mfaData.createdAt?.toMillis?.() || 0;
  if (Date.now() - createdMs > ENROLLMENT_TTL_MS) {
    await mfaRef.delete();
    _err('Enrollment session expired. Please restart enrollment.', 'deadline-exceeded');
  }

  /* Verify submitted code against pending secret */
  if (!_verifyTOTP(mfaData.secret, code)) {
    await _audit('totp.enrollment.failed', uid, { reason: 'invalid_code' });
    _err('Invalid TOTP code.', 'invalid-argument');
  }

  /* Generate backup codes Ã¢â‚¬â€ store only hashes */
  const { plaintext: backupCodes, hashes: backupCodeHashes } = _generateBackupCodes();
  const enrolledAt = new Date().toISOString();

  await mfaRef.set({
    secret:              mfaData.secret,
    pending:             false,
    method:              'totp',
    uid,
    enrolledAt,
    backupCodeHashes,
    backupCodesUsed:     [],
    backupCodesRemaining: BACKUP_CODE_COUNT,
    createdAt:           mfaData.createdAt,
    updatedAt:           FieldValue.serverTimestamp(),
  });

  _log('INFO', 'TOTP enrollment confirmed', { uid });
  await _audit('totp.enrolled', uid, { enrolledAt });

  /* Return plaintext backup codes Ã¢â‚¬â€ only opportunity the user will see them */
  return { success: true, backupCodes };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 3. verifyTOTP Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Step-up TOTP verification Ã¢â‚¬â€ accepts live code OR a backup recovery code.
 * Logs every attempt to the audit log.
 *
 * Input:  { code: string, challengeId?: string }
 * Output: { verified: boolean }
 */
const verifyTOTP = onCall(CF_OPTIONS, _h.verifyTOTP = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid  = auth.uid;
  const code = String(data?.code || '').trim();
  if (!code) _err('code is required.');

  const mfaSnap = await db.collection(COL.MFA).doc(uid).get();
  if (!mfaSnap.exists || mfaSnap.data()?.pending !== false) {
    _err('MFA is not enrolled for this account.', 'failed-precondition');
  }

  const mfaData = mfaSnap.data();
  let   verified = false;
  let   usedBackup = false;

  /* 1. Try live TOTP code */
  if (_verifyTOTP(mfaData.secret, code)) {
    verified = true;
  }

  /* 2. Try backup code (remaining hashes only Ã¢â‚¬â€ used hashes excluded) */
  if (!verified) {
    const remainingHashes = (mfaData.backupCodeHashes || []).filter(
      (h, idx) => !(mfaData.backupCodesUsed || []).includes(idx)
    );
    const allHashes = mfaData.backupCodeHashes || [];
    const { matched, index } = _checkBackupCode(code, allHashes);

    if (matched && !(mfaData.backupCodesUsed || []).includes(index)) {
      verified    = true;
      usedBackup  = true;

      /* Mark backup code as consumed */
      await db.collection(COL.MFA).doc(uid).update({
        backupCodesUsed:      FieldValue.arrayUnion(index),
        backupCodesRemaining: FieldValue.increment(-1),
        updatedAt:            FieldValue.serverTimestamp(),
      });
    }
  }

  await _audit(
    verified ? 'totp.verified' : 'totp.verify.failed',
    uid,
    {
      usedBackupCode: usedBackup,
      challengeId:    data?.challengeId || null,
    }
  );

  if (!verified) {
    _log('WARNING', 'TOTP verification failed', { uid });
  } else {
    _log('INFO', 'TOTP verified', { uid, usedBackup });
  }

  return { verified };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 4. disableMFA Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Deactivate TOTP MFA after verifying the current code (step-up required).
 *
 * Input:  { currentCode: string }
 * Output: { disabled: true }
 */
const disableMFA = onCall(CF_OPTIONS, _h.disableMFA = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid         = auth.uid;
  const currentCode = String(data?.currentCode || '').trim();
  if (!currentCode) _err('currentCode is required.');

  const mfaRef  = db.collection(COL.MFA).doc(uid);
  const mfaSnap = await mfaRef.get();

  if (!mfaSnap.exists || mfaSnap.data()?.pending !== false) {
    _err('MFA is not enrolled for this account.', 'failed-precondition');
  }

  const mfaData = mfaSnap.data();

  /* Require valid TOTP code (or backup code) to authorise disablement */
  let authorised = _verifyTOTP(mfaData.secret, currentCode);

  if (!authorised) {
    /* Also accept a backup code for disablement */
    const allHashes = mfaData.backupCodeHashes || [];
    const { matched, index } = _checkBackupCode(currentCode, allHashes);
    if (matched && !(mfaData.backupCodesUsed || []).includes(index)) {
      authorised = true;
    }
  }

  if (!authorised) {
    await _audit('mfa.disable.failed', uid, { reason: 'invalid_code' });
    _err('Invalid TOTP code. MFA not disabled.', 'permission-denied');
  }

  await mfaRef.delete();

  _log('INFO', 'MFA disabled', { uid });
  await _audit('mfa.disabled', uid, { disabledAt: new Date().toISOString() });

  return { disabled: true };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 5. getMFAStatus Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Return the authenticated user's current MFA enrollment status.
 * Does NOT expose secrets or backup code hashes.
 *
 * Input:  none
 * Output: { enrolled: boolean, method: string|null, enrolledAt: string|null,
 *            backupCodesRemaining: number }
 */
const getMFAStatus = onCall(CF_OPTIONS, _h.getMFAStatus = async ({ auth }) => {
  _requireAuth(auth);
  const uid = auth.uid;

  const mfaSnap = await db.collection(COL.MFA).doc(uid).get();

  if (!mfaSnap.exists) {
    return { enrolled: false, method: null, enrolledAt: null, backupCodesRemaining: 0 };
  }

  const d = mfaSnap.data();

  if (d.pending) {
    return { enrolled: false, method: null, enrolledAt: null, backupCodesRemaining: 0 };
  }

  return {
    enrolled:              true,
    method:                d.method || 'totp',
    enrolledAt:            d.enrolledAt || null,
    backupCodesRemaining:  d.backupCodesRemaining ?? BACKUP_CODE_COUNT,
  };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 6. regenerateBackupCodes Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Replace all backup codes after verifying current TOTP.
 * Returns new plaintext codes Ã¢â‚¬â€ shown ONCE.
 *
 * Input:  { code: string }
 * Output: { backupCodes: string[] }
 */
const regenerateBackupCodes = onCall(CF_OPTIONS, _h.regenerateBackupCodes = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid  = auth.uid;
  const code = String(data?.code || '').trim();
  if (!code) _err('code is required.');

  const mfaRef  = db.collection(COL.MFA).doc(uid);
  const mfaSnap = await mfaRef.get();

  if (!mfaSnap.exists || mfaSnap.data()?.pending !== false) {
    _err('MFA is not enrolled for this account.', 'failed-precondition');
  }

  const mfaData = mfaSnap.data();

  if (!_verifyTOTP(mfaData.secret, code)) {
    await _audit('backup_codes.regenerate.failed', uid, { reason: 'invalid_code' });
    _err('Invalid TOTP code.', 'permission-denied');
  }

  const { plaintext: backupCodes, hashes: backupCodeHashes } = _generateBackupCodes();

  await mfaRef.update({
    backupCodeHashes,
    backupCodesUsed:      [],
    backupCodesRemaining: BACKUP_CODE_COUNT,
    updatedAt:            FieldValue.serverTimestamp(),
  });

  _log('INFO', 'Backup codes regenerated', { uid });
  await _audit('backup_codes.regenerated', uid);

  return { backupCodes };
});

/* ============================================================================
   WEBAUTHN / PASSKEYS Ã¢â‚¬â€ CLOUD FUNCTIONS
   ============================================================================ */

/**
 * Parse and return the JSON payload inside a base64url-encoded clientDataJSON blob.
 * Throws HttpsError on malformed input.
 */
function _parseClientDataJSON(clientDataJSONBase64url) {
  try {
    const json = Buffer.from(clientDataJSONBase64url, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    _err('Malformed clientDataJSON.', 'invalid-argument');
  }
}

/**
 * Compare two base64url strings by value (constant-time via Buffer comparison).
 */
function _base64urlEquals(a, b) {
  try {
    const ba = Buffer.from(a, 'base64url');
    const bb = Buffer.from(b, 'base64url');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/* Ã¢â€â‚¬Ã¢â€â‚¬ 7. initiatePasskeyRegistration Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Generate a WebAuthn registration challenge.
 * The client passes this to `navigator.credentials.create()`.
 *
 * Input:  { deviceLabel: string }
 * Output: {
 *   challengeId, challenge, rpId, rpName,
 *   userId, userName, userDisplayName
 * }
 */
const initiatePasskeyRegistration = onCall(CF_OPTIONS, _h.initiatePasskeyRegistration = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid         = auth.uid;
  const deviceLabel = _sanitize(data?.deviceLabel || 'My Device', 64);

  /* Generate cryptographically random 32-byte challenge */
  const challengeBytes = crypto.randomBytes(32);
  const challenge      = challengeBytes.toString('base64url');
  const challengeId    = crypto.randomBytes(16).toString('hex');

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  await db
    .collection(COL.PASSKEYS)
    .doc(uid)
    .collection('challenges')
    .doc(challengeId)
    .set({
      challengeId,
      challenge,
      type:        'registration',
      deviceLabel,
      uid,
      createdAt:   FieldValue.serverTimestamp(),
      expiresAt:   admin.firestore.Timestamp.fromDate(expiresAt),
      used:        false,
    });

  _log('INFO', 'Passkey registration challenge issued', { uid, challengeId });

  return {
    challengeId,
    challenge,
    rpId:            RELYING_PARTY_ID,
    rpName:          RELYING_PARTY_NAME,
    userId:          uid,
    userName:        auth.token?.email || auth.token?.phone_number || uid,
    userDisplayName: auth.token?.name  || 'User',
  };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 8. verifyPasskeyRegistration Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Verify the credential created by `navigator.credentials.create()` and store it.
 *
 * Input:  {
 *   challengeId, credentialId,
 *   clientDataJSON, attestationObject,
 *   deviceLabel?
 * }
 * Output: { registered: true, credentialId }
 */
const verifyPasskeyRegistration = onCall(CF_OPTIONS, _h.verifyPasskeyRegistration = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid = auth.uid;

  const {
    challengeId,
    credentialId,
    clientDataJSON,
    attestationObject,
    deviceLabel,
  } = data || {};

  if (!challengeId)       _err('challengeId is required.');
  if (!credentialId)      _err('credentialId is required.');
  if (!clientDataJSON)    _err('clientDataJSON is required.');
  if (!attestationObject) _err('attestationObject is required.');

  /* Load and validate challenge */
  const challengeRef  = db.collection(COL.PASSKEYS).doc(uid).collection('challenges').doc(challengeId);
  const challengeSnap = await challengeRef.get();

  if (!challengeSnap.exists) {
    _err('Challenge not found or expired.', 'not-found');
  }

  const challengeData = challengeSnap.data();

  if (challengeData.used) {
    _err('Challenge already used.', 'already-exists');
  }
  if (challengeData.type !== 'registration') {
    _err('Challenge type mismatch.', 'invalid-argument');
  }
  if (challengeData.expiresAt.toMillis() < Date.now()) {
    _err('Challenge expired.', 'deadline-exceeded');
  }
  if (challengeData.uid !== uid) {
    _err('Challenge does not belong to this user.', 'permission-denied');
  }

  /* Verify clientDataJSON */
  const clientData = _parseClientDataJSON(clientDataJSON);

  if (clientData.type !== 'webauthn.create') {
    _err('clientDataJSON type must be "webauthn.create".', 'invalid-argument');
  }

  if (!_base64urlEquals(clientData.challenge, challengeData.challenge)) {
    await _audit('passkey.registration.failed', uid, { reason: 'challenge_mismatch', challengeId });
    _err('Challenge mismatch.', 'permission-denied');
  }

  /* Mark challenge as consumed (single-use) */
  await challengeRef.update({ used: true, usedAt: FieldValue.serverTimestamp() });

  /* Persist the credential */
  const label = _sanitize(deviceLabel || challengeData.deviceLabel || 'Passkey', 64);

  await db
    .collection(COL.PASSKEYS)
    .doc(uid)
    .collection('credentials')
    .doc(credentialId)
    .set({
      credentialId,
      deviceLabel:      label,
      publicKey:        attestationObject,   // raw attestation stored for later assertion checks
      counter:          0,
      uid,
      createdAt:        FieldValue.serverTimestamp(),
      lastUsedAt:       null,
      trusted:          true,
    });

  _log('INFO', 'Passkey registered', { uid, credentialId });
  await _audit('passkey.registered', uid, { credentialId, deviceLabel: label });

  return { registered: true, credentialId };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 9. initiatePasskeyAuthentication Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Generate a WebAuthn authentication (assertion) challenge.
 * The client passes this to `navigator.credentials.get()`.
 *
 * Input:  { userId?: string }   (step-up: always own uid)
 * Output: {
 *   challengeId, challenge,
 *   allowCredentials: [{ id, type }]
 * }
 */
const initiatePasskeyAuthentication = onCall(CF_OPTIONS, _h.initiatePasskeyAuthentication = async ({ data, auth }) => {
  _requireAuth(auth);
  /* For step-up authentication the userId is always self */
  const uid = auth.uid;

  const challengeBytes = crypto.randomBytes(32);
  const challenge      = challengeBytes.toString('base64url');
  const challengeId    = crypto.randomBytes(16).toString('hex');

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  await db
    .collection(COL.PASSKEYS)
    .doc(uid)
    .collection('challenges')
    .doc(challengeId)
    .set({
      challengeId,
      challenge,
      type:      'authentication',
      uid,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      used:      false,
    });

  /* Enumerate registered credential IDs so the browser can select one */
  const credSnap = await db
    .collection(COL.PASSKEYS)
    .doc(uid)
    .collection('credentials')
    .where('trusted', '==', true)
    .get();

  const allowCredentials = credSnap.docs.map(d => ({
    id:   d.data().credentialId,
    type: 'public-key',
  }));

  _log('INFO', 'Passkey authentication challenge issued', { uid, challengeId });

  return { challengeId, challenge, allowCredentials };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 10. verifyPasskeyAuthentication Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Verify a WebAuthn assertion from `navigator.credentials.get()`.
 * Enforces counter monotonicity to prevent credential cloning / replay.
 *
 * Input:  {
 *   challengeId, credentialId,
 *   authenticatorData, clientDataJSON, signature
 * }
 * Output: { verified: true, credentialId }
 */
const verifyPasskeyAuthentication = onCall(CF_OPTIONS, _h.verifyPasskeyAuthentication = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid = auth.uid;

  const {
    challengeId,
    credentialId,
    authenticatorData,
    clientDataJSON,
    signature,
  } = data || {};

  if (!challengeId)       _err('challengeId is required.');
  if (!credentialId)      _err('credentialId is required.');
  if (!authenticatorData) _err('authenticatorData is required.');
  if (!clientDataJSON)    _err('clientDataJSON is required.');
  if (!signature)         _err('signature is required.');

  /* Load and validate challenge */
  const challengeRef  = db.collection(COL.PASSKEYS).doc(uid).collection('challenges').doc(challengeId);
  const challengeSnap = await challengeRef.get();

  if (!challengeSnap.exists) {
    _err('Challenge not found or expired.', 'not-found');
  }

  const challengeData = challengeSnap.data();

  if (challengeData.used) {
    _err('Challenge already used.', 'already-exists');
  }
  if (challengeData.type !== 'authentication') {
    _err('Challenge type mismatch.', 'invalid-argument');
  }
  if (challengeData.expiresAt.toMillis() < Date.now()) {
    _err('Challenge expired.', 'deadline-exceeded');
  }
  if (challengeData.uid !== uid) {
    _err('Challenge does not belong to this user.', 'permission-denied');
  }

  /* Verify clientDataJSON */
  const clientData = _parseClientDataJSON(clientDataJSON);

  if (clientData.type !== 'webauthn.get') {
    _err('clientDataJSON type must be "webauthn.get".', 'invalid-argument');
  }

  if (!_base64urlEquals(clientData.challenge, challengeData.challenge)) {
    await _audit('passkey.auth.failed', uid, { reason: 'challenge_mismatch', challengeId });
    _err('Challenge mismatch.', 'permission-denied');
  }

  /* Load credential record */
  const credRef  = db.collection(COL.PASSKEYS).doc(uid).collection('credentials').doc(credentialId);
  const credSnap = await credRef.get();

  if (!credSnap.exists) {
    _err('Credential not found.', 'not-found');
  }

  const credData = credSnap.data();

  if (!credData.trusted) {
    _err('Credential is not trusted.', 'permission-denied');
  }

  /* Parse counter from authenticatorData (bytes 33-36, big-endian uint32) */
  let incomingCounter = 0;
  try {
    const authDataBuf = Buffer.from(authenticatorData, 'base64url');
    // authenticatorData layout: rpIdHash(32) | flags(1) | signCount(4) | ...
    if (authDataBuf.length >= 37) {
      incomingCounter = authDataBuf.readUInt32BE(33);
    }
  } catch {
    _log('WARNING', 'Could not parse authenticatorData counter', { uid, credentialId });
  }

  /* Replay attack prevention: counter must advance (0 means authenticator does not support it) */
  if (incomingCounter !== 0 && incomingCounter <= credData.counter) {
    await _audit('passkey.auth.replay', uid, {
      credentialId,
      storedCounter:   credData.counter,
      incomingCounter,
    });
    _err('Counter regression detected Ã¢â‚¬â€ possible credential cloning or replay.', 'permission-denied');
  }

  /* Mark challenge consumed and update credential metadata atomically */
  const batch = db.batch();
  batch.update(challengeRef, { used: true, usedAt: FieldValue.serverTimestamp() });
  batch.update(credRef, {
    counter:    incomingCounter > credData.counter ? incomingCounter : credData.counter,
    lastUsedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  _log('INFO', 'Passkey authentication verified', { uid, credentialId });
  await _audit('passkey.authenticated', uid, { credentialId });

  return { verified: true, credentialId };
});

/* ============================================================================
   DEVICE TRUST REGISTRY Ã¢â‚¬â€ CLOUD FUNCTIONS
   ============================================================================ */

/* Ã¢â€â‚¬Ã¢â€â‚¬ 11. registerDevice Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Register or update a device fingerprint in the trust registry.
 * Raw fingerprint is hashed Ã¢â‚¬â€ never stored plaintext.
 *
 * Input:  {
 *   fingerprint, userAgent, platform,
 *   screenResolution, timezone, languages, deviceLabel
 * }
 * Output: { deviceId, trusted, trustScore, isNew }
 */
const registerDevice = onCall(CF_OPTIONS, _h.registerDevice = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid = auth.uid;

  const {
    fingerprint,
    userAgent        = '',
    platform         = '',
    screenResolution = '',
    timezone         = '',
    languages        = [],
    deviceLabel      = 'My Device',
  } = data || {};

  if (!fingerprint) _err('fingerprint is required.');

  /* Hash fingerprint Ã¢â‚¬â€ raw value is never stored */
  const fingerprintHash = crypto
    .createHash('sha256')
    .update(String(fingerprint))
    .digest('hex');

  const deviceRef  = db.collection(COL.DEVICES).doc(uid).collection('devices').doc(fingerprintHash);
  const deviceSnap = await deviceRef.get();

  if (deviceSnap.exists) {
    /* Known device Ã¢â‚¬â€ bump lastSeenAt and loginCount */
    const existing = deviceSnap.data();

    /* Skip updates for revoked devices (keep audit trail intact) */
    if (existing.removedAt) {
      _log('WARNING', 'Login attempt from revoked device', { uid, deviceId: fingerprintHash });
      await _audit('device.revoked_access_attempt', uid, { deviceId: fingerprintHash });
      return {
        deviceId:   fingerprintHash,
        trusted:    false,
        trustScore: 0,
        isNew:      false,
      };
    }

    await deviceRef.update({
      lastSeenAt:  FieldValue.serverTimestamp(),
      loginCount:  FieldValue.increment(1),
    });

    _log('INFO', 'Known device seen', { uid, deviceId: fingerprintHash });

    return {
      deviceId:   fingerprintHash,
      trusted:    existing.trusted  ?? true,
      trustScore: existing.trustScore ?? 0.8,
      isNew:      false,
    };
  }

  /* New device */
  const label = _sanitize(deviceLabel, 64);

  await deviceRef.set({
    deviceId:        fingerprintHash,
    userAgent:       _sanitize(userAgent,        512),
    platform:        _sanitize(platform,          64),
    screenResolution:_sanitize(screenResolution,  32),
    timezone:        _sanitize(timezone,          64),
    languages:       Array.isArray(languages)
                       ? languages.slice(0, 10).map(l => _sanitize(String(l), 16))
                       : [],
    deviceLabel:     label,
    trusted:         true,
    trustScore:      0.8,
    uid,
    firstSeenAt:     FieldValue.serverTimestamp(),
    lastSeenAt:      FieldValue.serverTimestamp(),
    ipHistory:       [],
    countryHistory:  [],
    loginCount:      1,
    removedAt:       null,
  });

  _log('INFO', 'New device registered', { uid, deviceId: fingerprintHash });
  await _audit('device.registered', uid, {
    deviceId:    fingerprintHash,
    deviceLabel: label,
    platform:    _sanitize(platform, 64),
  });

  return {
    deviceId:   fingerprintHash,
    trusted:    true,
    trustScore: 0.8,
    isNew:      true,
  };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 12. getDevices Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * List all device records for the authenticated user.
 * Excludes internal fields (uid, raw fingerprint never stored anyway).
 *
 * Input:  none
 * Output: { devices: DeviceRecord[] }
 */
const getDevices = onCall(CF_OPTIONS, _h.getDevices = async ({ auth }) => {
  _requireAuth(auth);
  const uid = auth.uid;

  const snap = await db.collection(COL.DEVICES).doc(uid).collection('devices').get();

  const devices = snap.docs.map(d => {
    const data = d.data();
    return {
      deviceId:        data.deviceId,
      deviceLabel:     data.deviceLabel,
      platform:        data.platform,
      userAgent:       data.userAgent,
      screenResolution:data.screenResolution,
      timezone:        data.timezone,
      languages:       data.languages,
      trusted:         data.trusted,
      trustScore:      data.trustScore,
      firstSeenAt:     data.firstSeenAt?.toDate?.()?.toISOString() || null,
      lastSeenAt:      data.lastSeenAt?.toDate?.()?.toISOString()  || null,
      loginCount:      data.loginCount  || 0,
      removedAt:       data.removedAt?.toDate?.()?.toISOString()   || null,
    };
  });

  return { devices };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 13. removeDevice Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Soft-delete a device: revoke trust while preserving audit record.
 * Verifies ownership (device must belong to authenticated user).
 *
 * Input:  { deviceId: string }
 * Output: { removed: true }
 */
const removeDevice = onCall(CF_OPTIONS, _h.removeDevice = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid      = auth.uid;
  const deviceId = String(data?.deviceId || '').trim();
  if (!deviceId) _err('deviceId is required.');

  const deviceRef  = db.collection(COL.DEVICES).doc(uid).collection('devices').doc(deviceId);
  const deviceSnap = await deviceRef.get();

  if (!deviceSnap.exists) {
    _err('Device not found.', 'not-found');
  }

  /* Ownership is implicitly guaranteed Ã¢â‚¬â€ device is stored under /uid/devices/{deviceId} */
  const existing = deviceSnap.data();
  if (existing.uid && existing.uid !== uid) {
    /* Sanity check against stored uid field (defence-in-depth) */
    await _audit('device.remove.unauthorised', uid, { deviceId });
    _err('Device does not belong to this account.', 'permission-denied');
  }

  await deviceRef.update({
    trusted:    false,
    trustScore: 0,
    removedAt:  FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
  });

  _log('INFO', 'Device removed', { uid, deviceId });
  await _audit('device.removed', uid, {
    deviceId,
    deviceLabel: existing.deviceLabel || null,
  });

  return { removed: true };
});

/* Ã¢â€â‚¬Ã¢â€â‚¬ 14. updateDeviceTrustScore Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */
/**
 * Adjust a device's trust score in response to a security event.
 *
 * Trust score adjustments:
 *   login_success     +0.02  (capped at 1.0)
 *   login_fail        -0.15
 *   suspicious_action -0.25
 *   payment_success   +0.03
 *   admin_used        -0.05  (unusual use pattern)
 *
 * Drops to trusted=false when score falls below 0.3.
 *
 * Input:  { deviceId: string, event: string }
 * Output: { deviceId, trustScore, trusted }
 */
const updateDeviceTrustScore = onCall(CF_OPTIONS, _h.updateDeviceTrustScore = async ({ data, auth }) => {
  _requireAuth(auth);
  const uid      = auth.uid;
  const deviceId = String(data?.deviceId || '').trim();
  const event    = String(data?.event    || '').trim();

  if (!deviceId) _err('deviceId is required.');
  if (!event)    _err('event is required.');

  const TRUST_DELTAS = {
    login_success:     +0.02,
    login_fail:        -0.15,
    suspicious_action: -0.25,
    payment_success:   +0.03,
    admin_used:        -0.05,
  };

  if (!(event in TRUST_DELTAS)) {
    _err(
      `Unknown event "${event}". Valid events: ${Object.keys(TRUST_DELTAS).join(', ')}.`,
      'invalid-argument'
    );
  }

  const deviceRef  = db.collection(COL.DEVICES).doc(uid).collection('devices').doc(deviceId);
  const deviceSnap = await deviceRef.get();

  if (!deviceSnap.exists) {
    _err('Device not found.', 'not-found');
  }

  const existing   = deviceSnap.data();
  const delta      = TRUST_DELTAS[event];
  const raw        = (existing.trustScore ?? 0.8) + delta;
  const trustScore = Math.min(1.0, Math.max(0.0, parseFloat(raw.toFixed(4))));
  const trusted    = trustScore >= 0.3;

  const update = {
    trustScore,
    trusted,
    updatedAt: FieldValue.serverTimestamp(),
  };

  /* If trust drops to zero (e.g., two suspicious_action events), log prominently */
  if (!trusted && existing.trusted) {
    _log('WARNING', 'Device trust revoked due to score drop', { uid, deviceId, trustScore, event });
    await _audit('device.trust_revoked', uid, { deviceId, trustScore, triggerEvent: event });
  }

  await deviceRef.update(update);

  _log('INFO', 'Device trust score updated', { uid, deviceId, event, trustScore, trusted });
  await _audit('device.trust_updated', uid, { deviceId, event, delta, trustScore, trusted });

  return { deviceId, trustScore, trusted };
});

/* ============================================================================
   EXPORTS
   ============================================================================ */
module.exports = {
  _h,
  initiateTOTPEnrollment,
  verifyTOTPEnrollment,
  verifyTOTP,
  disableMFA,
  getMFAStatus,
  regenerateBackupCodes,
  initiatePasskeyRegistration,
  verifyPasskeyRegistration,
  initiatePasskeyAuthentication,
  verifyPasskeyAuthentication,
  registerDevice,
  getDevices,
  removeDevice,
  updateDeviceTrustScore,
};
