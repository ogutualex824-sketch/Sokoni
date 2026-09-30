/* ================================================================
   SOKONI Zero Trust Security Middleware v1.0
   functions/security-zero-trust.js

   evaluateAccessRequest   — ABAC decision engine
   generateCorrelationId   — request correlation ID generator
   getSessionRiskScore     — session risk scoring
   triggerStepUpAuth       — initiate step-up authentication challenge
   verifyStepUpAuth        — verify step-up auth response
   getRiskProfile          — read user's risk profile
   updateRiskProfile       — recalculate and persist risk profile
   getZeroTrustPolicyStatus — admin policy health snapshot
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const SOKONI_HMAC_KEY = defineSecret('SOKONI_HMAC_KEY');
const CF_OPTIONS = { region: 'us-central1', enforceAppCheck: true, secrets: [SOKONI_HMAC_KEY] };

/* ── Role levels ───────────────────────────────────────────────────────────── */
const ROLE = {
  cashier:     0,
  supervisor:  1,
  manager:     2,
  owner:       3,
  admin:       4,
  super_admin: 5,
};

/* ── Risk levels ───────────────────────────────────────────────────────────── */
const RISK_LEVEL = { low: 'low', medium: 'medium', high: 'high', critical: 'critical' };

/* ── Constants ─────────────────────────────────────────────────────────────── */
const HIGH_VALUE_THRESHOLD_KES = 100_000;
const STEP_UP_TTL_MS           = 10 * 60 * 1000; // 10 minutes
// Accessed via Secret Manager — SOKONI_HMAC_KEY is injected at runtime by Firebase
const _getHmacKey = () => {
  const key = SOKONI_HMAC_KEY.value();
  if (!key) throw new HttpsError('internal', 'HMAC key not configured.');
  return key;
};

/* ── Helpers ───────────────────────────────────────────────────────────────── */
function _requireAuth(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');
}

function _requireRole(auth, minRole) {
  _requireAuth(auth);
  const r = auth.token.role;
  const level = typeof r === 'number' ? r : (ROLE[r] ?? 0);
  if (level < minRole) throw new HttpsError('permission-denied', 'Insufficient role.');
}

function _isElevated(auth) {
  return ['admin', 'super_admin', 4, 5].includes(auth?.token?.role);
}

function _roleLevel(auth) {
  const r = auth?.token?.role;
  if (r === undefined || r === null) return 0;
  return typeof r === 'number' ? r : (ROLE[r] ?? 0);
}

function _sanitize(s) {
  if (typeof s !== 'string') return String(s || '');
  return s.replace(/[<>"'&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c]));
}

function _err(msg, code = 'invalid-argument') {
  throw new HttpsError(code, msg);
}

/** Resolve a risk score (0–100) to a level label. */
function _scoreToLevel(score) {
  if (score >= 80) return RISK_LEVEL.critical;
  if (score >= 55) return RISK_LEVEL.high;
  if (score >= 30) return RISK_LEVEL.medium;
  return RISK_LEVEL.low;
}

/** Write an immutable audit log entry. */
async function _auditLog(event) {
  try {
    await db.collection('securityAuditLog').add({
      ...event,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (_) {
    // Audit log must never crash the calling function
  }
}

/** Generate a Zero Trust correlation ID without external dependencies. */
function _makeCorrelationId() {
  const tsHex  = Math.floor(Date.now()).toString(16);
  const rand   = crypto.randomBytes(3).toString('hex');
  return `zt-${tsHex}-${rand}`;
}

/** Generate a short nonce. */
function _nonce() {
  return crypto.randomBytes(8).toString('hex');
}

/* ════════════════════════════════════════════════════════════════════════════
   1. evaluateAccessRequest — ABAC decision engine
   Input : { userId, action, resource, context }
   context: { deviceTrust, sessionAge, ipCountry, branchId, storeId,
              shiftActive, transactionAmount, deviceId }
   Output: { allowed, reason, requiresStepUp, stepUpReason }
════════════════════════════════════════════════════════════════════════════ */
exports.evaluateAccessRequest = onCall(CF_OPTIONS, async ({ data, auth }) => {
  _requireAuth(auth);
  try {
    const {
      userId,
      action,
      resource,
      context = {},
    } = data || {};

    if (!userId || !action || !resource) {
      _err('userId, action, and resource are required.');
    }

    const {
      deviceTrust   = 0,
      sessionAge    = Infinity,   // seconds
      ipCountry     = null,
      branchId      = null,
      storeId       = null,
      shiftActive   = false,
      transactionAmount = 0,
      deviceId      = null,
    } = context;

    /* ── Load caller role from custom claims ──────────────────────────── */
    let userRole = 0;
    let mfaEnrolled = false;
    try {
      const userRecord = await admin.auth().getUser(userId);
      const claims = userRecord.customClaims || {};
      const r = claims.role;
      userRole = typeof r === 'number' ? r : (ROLE[r] ?? 0);
      mfaEnrolled = !!claims.mfaEnrolled || (userRecord.multiFactor?.enrolledFactors?.length > 0);
    } catch (e) {
      _err('Unable to retrieve user account.', 'not-found');
    }

    /* ── Load risk profile ────────────────────────────────────────────── */
    let overallRisk = 0;
    try {
      const riskSnap = await db.collection('securityRisk').doc(userId).get();
      if (riskSnap.exists) overallRisk = riskSnap.data()?.overallScore ?? 0;
    } catch (_) { /* tolerate */ }

    /* ── Load device trust from Firestore if deviceId supplied ─────────── */
    let resolvedDeviceTrust = deviceTrust;
    if (deviceId) {
      try {
        const devSnap = await db
          .collection('securityDevices')
          .doc(userId)
          .collection('devices')
          .doc(deviceId)
          .get();
        if (devSnap.exists) {
          resolvedDeviceTrust = devSnap.data()?.trustScore ?? deviceTrust;
        }
      } catch (_) { /* tolerate */ }
    }

    const sessionAgeHours = sessionAge / 3600;

    /* ── Decision rules ───────────────────────────────────────────────── */
    let allowed          = true;
    let reason           = 'Access granted.';
    let requiresStepUp   = false;
    let stepUpReason     = '';

    // Blocked outright if critical risk
    if (overallRisk >= 80) {
      allowed = false;
      reason  = 'Account flagged as critical risk. Contact support.';
    }

    // Shift-gated POS actions
    if (allowed && _isPOSAction(action) && !shiftActive) {
      allowed = false;
      reason  = 'POS action requires an active shift.';
    }

    // Branch-restricted actions
    if (allowed && branchId) {
      const ownsOrAdmin = await _userOwnsBranch(userId, branchId, userRole);
      if (!ownsOrAdmin) {
        allowed = false;
        reason  = "Action restricted to this branch's authorised staff.";
      }
    }

    // High-value transactions (> KES 100,000)
    if (allowed && transactionAmount > HIGH_VALUE_THRESHOLD_KES) {
      if (resolvedDeviceTrust < 0.7) {
        allowed = false;
        reason  = 'High-value transaction requires a trusted device (trust score ≥ 0.7).';
      } else if (sessionAgeHours >= 4) {
        allowed       = false;
        requiresStepUp = true;
        reason        = 'Session has exceeded 4 hours. Re-authenticate to proceed.';
        stepUpReason  = 'High-value transaction session timeout.';
      } else if (!mfaEnrolled) {
        allowed       = false;
        requiresStepUp = true;
        reason        = 'MFA required for high-value transactions.';
        stepUpReason  = 'Enrol MFA to authorise transactions above KES 100,000.';
      }
    }

    // Admin actions (role >= 4)
    if (allowed && _isAdminAction(action)) {
      if (userRole < ROLE.admin) {
        allowed = false;
        reason  = 'Admin role required.';
      } else if (resolvedDeviceTrust < 0.8) {
        allowed       = false;
        requiresStepUp = true;
        reason        = 'Admin actions require a highly trusted device (trust score ≥ 0.8).';
        stepUpReason  = 'Verify your device trust to proceed with admin operations.';
      } else if (sessionAgeHours >= 2) {
        allowed       = false;
        requiresStepUp = true;
        reason        = 'Admin session has exceeded 2 hours. Re-authenticate.';
        stepUpReason  = 'Session re-authentication required for admin actions.';
      }
    }

    // Financial writes — payouts, refunds (role >= 3)
    if (allowed && _isFinancialWrite(action)) {
      if (userRole < ROLE.owner) {
        allowed = false;
        reason  = 'Owner or higher role required for financial writes.';
      } else if (!mfaEnrolled) {
        allowed       = false;
        requiresStepUp = true;
        reason        = 'MFA is required for payouts and refunds.';
        stepUpReason  = 'Enrol MFA to authorise financial operations.';
      } else if (sessionAgeHours >= 8) {
        allowed       = false;
        requiresStepUp = true;
        reason        = 'Session older than 8 hours. Re-authenticate for financial operations.';
        stepUpReason  = 'Financial session re-authentication required.';
      }
    }

    /* ── Audit log ────────────────────────────────────────────────────── */
    await _auditLog({
      type:            'access_decision',
      userId,
      action:          _sanitize(action),
      resource:        _sanitize(resource),
      allowed,
      reason,
      requiresStepUp,
      userRole,
      overallRisk,
      resolvedDeviceTrust,
      sessionAgeHours,
      ipCountry:       ipCountry ? _sanitize(ipCountry) : null,
      branchId:        branchId  ? _sanitize(branchId)  : null,
      storeId:         storeId   ? _sanitize(storeId)   : null,
      correlationId:   _makeCorrelationId(),
    });

    return { allowed, reason, requiresStepUp, stepUpReason };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('[evaluateAccessRequest]', e.message);
    throw new HttpsError('internal', 'Access evaluation failed.');
  }
});

/* ── Action classification helpers ─────────────────────────────────────── */
function _isPOSAction(action) {
  return /^pos\.|sale\.|shift\.|till\./i.test(action);
}
function _isAdminAction(action) {
  return /^admin\.|user\.delete|user\.ban|platform\.|config\./i.test(action);
}
function _isFinancialWrite(action) {
  return /payout|refund|withdrawal|disbursement/i.test(action);
}

async function _userOwnsBranch(userId, branchId, userRole) {
  if (userRole >= ROLE.admin) return true;
  try {
    const snap = await db.collection('branches').doc(branchId).get();
    if (!snap.exists) return false;
    const d = snap.data();
    return d.ownerId === userId || (d.staffIds || []).includes(userId);
  } catch (_) {
    return false;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   2. generateCorrelationId — returns a unique ZT correlation ID
   Output: { correlationId: string }
════════════════════════════════════════════════════════════════════════════ */
exports.generateCorrelationId = onCall(CF_OPTIONS, async ({ auth }) => {
  _requireAuth(auth);
  try {
    const correlationId = _makeCorrelationId();
    return { correlationId };
  } catch (e) {
    console.error('[generateCorrelationId]', e.message);
    throw new HttpsError('internal', 'Failed to generate correlation ID.');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   3. getSessionRiskScore — evaluate session risk
   Input : { userId, deviceId, ipAddress, userAgent, lastActionAt }
   Output: { score, level, factors }
════════════════════════════════════════════════════════════════════════════ */
exports.getSessionRiskScore = onCall(CF_OPTIONS, async ({ data, auth }) => {
  _requireAuth(auth);
  try {
    const {
      userId,
      deviceId     = null,
      ipAddress    = null,
      userAgent    = null,
      lastActionAt = null,
    } = data || {};

    if (!userId) _err('userId is required.');

    // Caller must be the user themselves or an admin
    const callerRole = _roleLevel(auth);
    if (auth.uid !== userId && callerRole < ROLE.admin) {
      throw new HttpsError('permission-denied', "Cannot score another user's session.");
    }

    let score   = 0;
    const factors = [];

    /* ── Factor: new/unknown device ──────────────────────────────────── */
    if (deviceId) {
      const devSnap = await db
        .collection('securityDevices')
        .doc(userId)
        .collection('devices')
        .doc(deviceId)
        .get();
      if (!devSnap.exists) {
        score += 30;
        factors.push('Unrecognised device (+30)');
      }
    }

    /* ── Factor: IP country mismatch ─────────────────────────────────── */
    if (ipAddress) {
      try {
        const riskSnap = await db.collection('securityRisk').doc(userId).get();
        if (riskSnap.exists) {
          const usualCountry = riskSnap.data()?.usualCountry;
          if (usualCountry && ipAddress) {
            // We store last known country in the risk profile
            const currentCountry = riskSnap.data()?.lastSeenCountry;
            if (currentCountry && usualCountry !== currentCountry) {
              score += 25;
              factors.push(`IP country mismatch: usual=${usualCountry}, current=${currentCountry} (+25)`);
            }
          }
        }
      } catch (_) { /* tolerate */ }
    }

    /* ── Factor: session age > 8h ────────────────────────────────────── */
    if (lastActionAt) {
      const ageMs = Date.now() - new Date(lastActionAt).getTime();
      if (ageMs > 8 * 3600 * 1000) {
        score += 10;
        factors.push('Session age exceeds 8 hours (+10)');
      }
    }

    /* ── Factor: recent failed logins (last 1h) ──────────────────────── */
    const oneHourAgo = new Date(Date.now() - 3600 * 1000);
    const failedSnap = await db.collection('securityEvents')
      .where('userId',    '==', userId)
      .where('type',      '==', 'login_failed')
      .where('createdAt', '>=', oneHourAgo)
      .limit(10)
      .get();
    if (failedSnap.size > 3) {
      score += 20;
      factors.push(`${failedSnap.size} failed logins in last hour (+20)`);
    }

    /* ── Factor: no MFA enrolled ─────────────────────────────────────── */
    try {
      const userRecord = await admin.auth().getUser(userId);
      const hasMfa =
        !!(userRecord.customClaims?.mfaEnrolled) ||
        (userRecord.multiFactor?.enrolledFactors?.length > 0);
      if (!hasMfa) {
        score += 15;
        factors.push('MFA not enrolled (+15)');
      }
    } catch (_) { /* tolerate */ }

    score = Math.min(100, Math.max(0, score));
    const level = _scoreToLevel(score);

    return { score, level, factors };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('[getSessionRiskScore]', e.message);
    throw new HttpsError('internal', 'Risk scoring failed.');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   4. triggerStepUpAuth — create a step-up challenge for a sensitive action
   Input : { userId, action, reason }
   Output: { challengeId, expiresAt, methods }
════════════════════════════════════════════════════════════════════════════ */
exports.triggerStepUpAuth = onCall(CF_OPTIONS, async ({ data, auth }) => {
  _requireAuth(auth);
  _requireRole(auth, ROLE.cashier);
  try {
    const { userId, action, reason } = data || {};
    if (!userId || !action) _err('userId and action are required.');

    // Only the user or an admin may trigger a step-up for a given userId
    const callerRole = _roleLevel(auth);
    if (auth.uid !== userId && callerRole < ROLE.admin) {
      throw new HttpsError('permission-denied', 'Cannot trigger step-up for another user.');
    }

    const nonce       = _nonce();
    const challengeId = `${userId}_${nonce}`;
    const expiresAt   = new Date(Date.now() + STEP_UP_TTL_MS).toISOString();

    await db.collection('securityStepUp').doc(challengeId).set({
      challengeId,
      userId:    _sanitize(userId),
      action:    _sanitize(action),
      reason:    _sanitize(reason || ''),
      methods:   ['totp', 'sms', 'passkey'],
      used:      false,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
    });

    await _auditLog({
      type:        'step_up_triggered',
      userId:      _sanitize(userId),
      action:      _sanitize(action),
      reason:      _sanitize(reason || ''),
      challengeId,
      expiresAt,
    });

    return {
      challengeId,
      expiresAt,
      methods: ['totp', 'sms', 'passkey'],
    };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('[triggerStepUpAuth]', e.message);
    throw new HttpsError('internal', 'Failed to create step-up challenge.');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   5. verifyStepUpAuth — verify the client's response to a step-up challenge
   Input : { challengeId, method, verificationToken }
   Output: { verified, token }
════════════════════════════════════════════════════════════════════════════ */
exports.verifyStepUpAuth = onCall(CF_OPTIONS, async ({ data, auth }) => {
  _requireAuth(auth);
  try {
    const { challengeId, method, verificationToken } = data || {};
    if (!challengeId || !method || !verificationToken) {
      _err('challengeId, method, and verificationToken are required.');
    }

    const chalRef  = db.collection('securityStepUp').doc(challengeId);
    const chalSnap = await chalRef.get();

    if (!chalSnap.exists) {
      throw new HttpsError('not-found', 'Challenge not found.');
    }

    const chal = chalSnap.data();

    // Only the owning user or admin may verify
    const callerRole = _roleLevel(auth);
    if (auth.uid !== chal.userId && callerRole < ROLE.admin) {
      throw new HttpsError('permission-denied', 'Not authorised to verify this challenge.');
    }

    // Check expiry
    if (new Date(chal.expiresAt) < new Date()) {
      throw new HttpsError('deadline-exceeded', 'Step-up challenge has expired.');
    }

    // Check already used
    if (chal.used) {
      throw new HttpsError('already-exists', 'Challenge has already been used.');
    }

    const userId = chal.userId;
    let verified = false;

    /* ── Method: TOTP ────────────────────────────────────────────────── */
    if (method === 'totp') {
      try {
        const mfaSnap = await db.collection('securityMFA').doc(userId).get();
        if (mfaSnap.exists) {
          const stored = mfaSnap.data()?.totpVerified;
          // In production integrate a real TOTP library (e.g. otplib).
          // Here we do a constant-time comparison of the provided token against
          // a server-computed TOTP or stored validated token.
          if (stored && verificationToken) {
            verified = crypto.timingSafeEqual(
              Buffer.from(_sanitize(verificationToken), 'utf8').slice(0, 64),
              Buffer.from(String(stored).padEnd(64, '\0').slice(0, 64), 'utf8'),
            );
          }
        }
      } catch (_) {
        verified = false;
      }
    }

    /* ── Method: SMS OTP ─────────────────────────────────────────────── */
    else if (method === 'sms') {
      try {
        const mfaSnap = await db.collection('securityMFA').doc(userId).get();
        if (mfaSnap.exists) {
          const record = mfaSnap.data()?.smsOTP;
          if (record && record.code && record.expiresAt) {
            const notExpired = new Date(record.expiresAt) > new Date();
            const matches    = crypto.timingSafeEqual(
              Buffer.from(String(record.code).padEnd(10, '\0').slice(0, 10), 'utf8'),
              Buffer.from(String(verificationToken).padEnd(10, '\0').slice(0, 10), 'utf8'),
            );
            verified = notExpired && matches;
          }
        }
      } catch (_) {
        verified = false;
      }
    }

    /* ── Method: Passkey ─────────────────────────────────────────────── */
    else if (method === 'passkey') {
      try {
        const pkSnap = await db.collection('securityPasskeys').doc(userId).get();
        if (pkSnap.exists) {
          const assertion = pkSnap.data()?.pendingAssertion;
          if (assertion && verificationToken) {
            verified = crypto.timingSafeEqual(
              Buffer.from(String(assertion).padEnd(256, '\0').slice(0, 256), 'utf8'),
              Buffer.from(String(verificationToken).padEnd(256, '\0').slice(0, 256), 'utf8'),
            );
          }
        }
      } catch (_) {
        verified = false;
      }
    } else {
      _err(`Unsupported method: ${method}`);
    }

    // Mark challenge as used regardless of outcome to prevent replay
    await chalRef.update({ used: true, verifiedAt: FieldValue.serverTimestamp(), verifiedMethod: method });

    let signedToken = '';
    if (verified) {
      const ts = Date.now();
      signedToken = crypto
        .createHmac('sha256', _getHmacKey())
        .update(`step-up:${challengeId}:${userId}:${ts}`)
        .digest('hex');
    }

    await _auditLog({
      type:        verified ? 'step_up_verified' : 'step_up_failed',
      userId:      _sanitize(userId),
      challengeId,
      method:      _sanitize(method),
      verified,
    });

    return { verified, token: signedToken };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('[verifyStepUpAuth]', e.message);
    throw new HttpsError('internal', 'Step-up verification failed.');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   6. getRiskProfile — read a user's security risk profile
   Input : { userId }
   Output: full risk profile document + derived fields
════════════════════════════════════════════════════════════════════════════ */
exports.getRiskProfile = onCall(CF_OPTIONS, async ({ data, auth }) => {
  _requireAuth(auth);
  try {
    const { userId } = data || {};
    if (!userId) _err('userId is required.');

    // Must be own profile or owner+
    const callerRole = _roleLevel(auth);
    if (auth.uid !== userId && callerRole < ROLE.owner) {
      throw new HttpsError('permission-denied', "Cannot read another users risk profile.");
    }

    const riskSnap = await db.collection('securityRisk').doc(userId).get();
    const profile  = riskSnap.exists ? riskSnap.data() : {};

    // Recent incidents count
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const incidentsSnap = await db.collection('securityIncidents')
      .where('userId', '==', userId)
      .where('createdAt', '>=', thirtyDaysAgo)
      .count()
      .get();
    const recentIncidents = incidentsSnap.data().count;

    // MFA enrolled
    let mfaEnrolled = profile.mfaEnrolled ?? false;
    try {
      const userRecord = await admin.auth().getUser(userId);
      mfaEnrolled =
        !!(userRecord.customClaims?.mfaEnrolled) ||
        (userRecord.multiFactor?.enrolledFactors?.length > 0);
    } catch (_) { /* tolerate */ }

    // Trusted device count
    let trustedDeviceCount = 0;
    try {
      const devSnap = await db
        .collection('securityDevices')
        .doc(userId)
        .collection('devices')
        .where('trusted', '==', true)
        .count()
        .get();
      trustedDeviceCount = devSnap.data().count;
    } catch (_) { /* tolerate */ }

    return {
      overallScore:      profile.overallScore      ?? 0,
      riskLevel:         profile.riskLevel          ?? RISK_LEVEL.low,
      lastUpdated:       profile.lastUpdated        ?? null,
      factors:           profile.factors            ?? {},
      recentIncidents,
      mfaEnrolled,
      trustedDeviceCount,
      usualCountry:      profile.usualCountry       ?? null,
      lastSeenCountry:   profile.lastSeenCountry    ?? null,
    };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('[getRiskProfile]', e.message);
    throw new HttpsError('internal', 'Failed to retrieve risk profile.');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   7. updateRiskProfile — recalculate and persist securityRisk/{userId}
   Input : { userId }
   Callable by admin (role >= 4); also invoked internally.
════════════════════════════════════════════════════════════════════════════ */
exports.updateRiskProfile = onCall(CF_OPTIONS, async ({ data, auth }) => {
  _requireAuth(auth);
  try {
    const { userId } = data || {};
    if (!userId) _err('userId is required.');

    const callerRole = _roleLevel(auth);
    if (auth.uid !== userId && callerRole < ROLE.admin) {
      throw new HttpsError('permission-denied', "Admin role required to update another user profile.");
    }

    await _recalculateRiskProfile(userId);
    return { success: true, userId };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('[updateRiskProfile]', e.message);
    throw new HttpsError('internal', 'Failed to update risk profile.');
  }
});

/**
 * Internal: recalculate and atomically write securityRisk/{userId}.
 * Called by updateRiskProfile CF and can be reused by scheduled jobs.
 */
async function _recalculateRiskProfile(userId) {
  let score = 0;
  const factors = {};

  /* ── MFA enrollment ──────────────────────────────────────────────────── */
  let mfaEnrolled   = false;
  let userRoleLevel = 0;
  try {
    const userRecord = await admin.auth().getUser(userId);
    mfaEnrolled =
      !!(userRecord.customClaims?.mfaEnrolled) ||
      (userRecord.multiFactor?.enrolledFactors?.length > 0);
    const r = userRecord.customClaims?.role;
    userRoleLevel = typeof r === 'number' ? r : (ROLE[r] ?? 0);
  } catch (_) { /* tolerate */ }

  if (!mfaEnrolled) {
    score += 20;
    factors.noMfa = 20;
  }

  /* ── Recent security events (30 days) ───────────────────────────────── */
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  let recentFailures = 0;
  try {
    const evSnap = await db.collection('securityEvents')
      .where('userId',    '==', userId)
      .where('type',      '==', 'login_failed')
      .where('createdAt', '>=', thirtyDaysAgo)
      .count()
      .get();
    recentFailures = evSnap.data().count;
  } catch (_) { /* tolerate */ }

  if (recentFailures > 10) {
    score += 25;
    factors.manyLoginFailures = 25;
  } else if (recentFailures > 3) {
    score += 10;
    factors.someLoginFailures = 10;
  }

  /* ── Device trust scores ─────────────────────────────────────────────── */
  let avgDeviceTrust = 1;
  let deviceCount    = 0;
  try {
    const devSnap = await db
      .collection('securityDevices')
      .doc(userId)
      .collection('devices')
      .get();
    if (!devSnap.empty) {
      const scores = devSnap.docs.map(d => d.data()?.trustScore ?? 0.5);
      deviceCount   = scores.length;
      avgDeviceTrust = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  } catch (_) { /* tolerate */ }

  if (avgDeviceTrust < 0.4) {
    score += 20;
    factors.lowDeviceTrust = 20;
  } else if (avgDeviceTrust < 0.7) {
    score += 10;
    factors.moderateDeviceTrust = 10;
  }

  /* ── Payment history: chargebacks / disputes ─────────────────────────── */
  try {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    const disputeSnap  = await db.collection('orders')
      .where('sellerId',   '==', userId)
      .where('status',     'in', ['chargeback', 'disputed'])
      .where('updatedAt',  '>=', sixtyDaysAgo)
      .count()
      .get();
    const disputes = disputeSnap.data().count;
    if (disputes > 5) {
      score += 20;
      factors.highDisputeRate = 20;
    } else if (disputes > 1) {
      score += 8;
      factors.someDisputes = 8;
    }
  } catch (_) { /* tolerate */ }

  /* ── Role accountability offset ──────────────────────────────────────── */
  // Higher roles carry higher accountability expectations → reduce base risk
  const roleDiscount = Math.min(userRoleLevel * 3, 12);
  score = Math.max(0, score - roleDiscount);
  if (roleDiscount > 0) factors.roleDiscount = -roleDiscount;

  score = Math.min(100, Math.max(0, score));
  const riskLevel = _scoreToLevel(score);

  await db.collection('securityRisk').doc(userId).set({
    userId,
    overallScore:    score,
    riskLevel,
    mfaEnrolled,
    factors,
    deviceCount,
    avgDeviceTrust,
    recentFailures,
    lastUpdated:     FieldValue.serverTimestamp(),
  }, { merge: true });

  return { score, riskLevel };
}

/* ════════════════════════════════════════════════════════════════════════════
   8. getZeroTrustPolicyStatus — admin-only ZT health snapshot
   Output: { policy, metrics, health }
════════════════════════════════════════════════════════════════════════════ */
exports.getZeroTrustPolicyStatus = onCall(CF_OPTIONS, async ({ auth }) => {
  _requireAuth(auth);
  _requireRole(auth, ROLE.admin);
  try {
    const now          = new Date();
    const oneDayAgo    = new Date(now.getTime() - 24 * 3600 * 1000);

    /* ── Total users ───────────────────────────────────────────────────── */
    let totalUsers = 0;
    try {
      const usersSnap = await db.collection('users').count().get();
      totalUsers = usersSnap.data().count;
    } catch (_) { /* tolerate */ }

    /* ── MFA adoption ──────────────────────────────────────────────────── */
    let mfaCount = 0;
    try {
      const mfaSnap = await db.collection('securityRisk')
        .where('mfaEnrolled', '==', true)
        .count()
        .get();
      mfaCount = mfaSnap.data().count;
    } catch (_) { /* tolerate */ }
    const mfaAdoptionPct = totalUsers > 0 ? Math.round((mfaCount / totalUsers) * 100) : 0;

    /* ── High-risk users ───────────────────────────────────────────────── */
    let highRiskCount = 0;
    try {
      const hrSnap = await db.collection('securityRisk')
        .where('riskLevel', 'in', ['high', 'critical'])
        .count()
        .get();
      highRiskCount = hrSnap.data().count;
    } catch (_) { /* tolerate */ }

    /* ── Untrusted device sessions ─────────────────────────────────────── */
    let untrustedDeviceSessions = 0;
    try {
      const udtSnap = await db.collection('securityAuditLog')
        .where('type',                  '==', 'access_decision')
        .where('createdAt',             '>=', oneDayAgo)
        .where('resolvedDeviceTrust',   '<',   0.5)
        .count()
        .get();
      untrustedDeviceSessions = udtSnap.data().count;
    } catch (_) { /* tolerate */ }

    /* ── Step-up triggers (24h) ────────────────────────────────────────── */
    let stepUpTriggers24h = 0;
    try {
      const suSnap = await db.collection('securityAuditLog')
        .where('type',      '==', 'step_up_triggered')
        .where('createdAt', '>=', oneDayAgo)
        .count()
        .get();
      stepUpTriggers24h = suSnap.data().count;
    } catch (_) { /* tolerate */ }

    /* ── Blocked requests (24h) ────────────────────────────────────────── */
    let blockedRequests24h = 0;
    try {
      const blSnap = await db.collection('securityAuditLog')
        .where('type',      '==', 'access_decision')
        .where('allowed',   '==', false)
        .where('createdAt', '>=', oneDayAgo)
        .count()
        .get();
      blockedRequests24h = blSnap.data().count;
    } catch (_) { /* tolerate */ }

    /* ── Health signal ─────────────────────────────────────────────────── */
    let health = 'green';
    if (mfaAdoptionPct < 50 || highRiskCount > totalUsers * 0.1) {
      health = 'red';
    } else if (mfaAdoptionPct < 75 || highRiskCount > totalUsers * 0.05) {
      health = 'yellow';
    }

    const policy = {
      highValueThresholdKES:   HIGH_VALUE_THRESHOLD_KES,
      sessionMaxAgeAdminHours: 2,
      sessionMaxAgeStandardHours: 8,
      sessionMaxAgeHighValueHours: 4,
      minDeviceTrustAdmin:     0.8,
      minDeviceTrustHighValue: 0.7,
      mfaRequiredForFinancial: true,
      mfaRequiredForHighValue: true,
      stepUpTtlMinutes:        10,
      enforcedRegion:          'us-central1',
      appCheckEnforced:        true,
    };

    const metrics = {
      totalUsers,
      mfaCount,
      mfaAdoptionPct,
      highRiskCount,
      untrustedDeviceSessions,
      stepUpTriggers24h,
      blockedRequests24h,
      generatedAt: now.toISOString(),
    };

    await _auditLog({
      type:         'zt_policy_status_read',
      callerUid:    auth.uid,
      health,
      mfaAdoptionPct,
      highRiskCount,
      blockedRequests24h,
    });

    return { policy, metrics, health };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('[getZeroTrustPolicyStatus]', e.message);
    throw new HttpsError('internal', 'Failed to retrieve ZT policy status.');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   Exports
════════════════════════════════════════════════════════════════════════════ */
module.exports = {
  evaluateAccessRequest:    exports.evaluateAccessRequest,
  generateCorrelationId:    exports.generateCorrelationId,
  getSessionRiskScore:      exports.getSessionRiskScore,
  triggerStepUpAuth:        exports.triggerStepUpAuth,
  verifyStepUpAuth:         exports.verifyStepUpAuth,
  getRiskProfile:           exports.getRiskProfile,
  updateRiskProfile:        exports.updateRiskProfile,
  getZeroTrustPolicyStatus: exports.getZeroTrustPolicyStatus,
};
