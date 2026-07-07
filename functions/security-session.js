/* ============================================================================
   SOKONI Security 6.0 — Enterprise Session Management Engine
   functions/security-session.js
   Firebase Cloud Functions Gen2 · Node.js 22
   ============================================================================

   Server-authoritative session lifecycle: creation, validation, rotation,
   termination, anomaly detection, heartbeat, and scheduled cleanup.

   Functions (10 total):

   Session Lifecycle (5)
     createSession            — create session record on sign-in
     validateSession          — validate integrity + IP anomaly check
     rotateSession            — issue new sessionId, revoke old (anti-fixation)
     terminateSession         — immediately revoke one session
     terminateAllSessions     — remote logout: revoke all sessions for a user

   Session Queries (2)
     getUserSessions          — list active sessions for authenticated user
     revokeDeviceSessions     — revoke all sessions for a specific deviceId

   Session Maintenance (3)
     updateSessionActivity    — heartbeat: touch lastActivity every ~5 min
     detectSessionAnomaly     — deep anomaly analysis (travel, fingerprint, rotation)
     scheduledSessionCleanup  — 24h sweep: expire stale / inactive sessions

   Firestore Collections:
     securitySessions/{sessionId}             — session records
     securitySessions/{sessionId}/events/{id} — per-session event trail
     securityAuditLog/{id}                    — platform-wide immutable audit log

   Required Indexes (composite):
     securitySessions: (userId ASC, isRevoked ASC)
     securitySessions: (userId ASC, isRevoked ASC, lastActivity DESC)
     securitySessions: (userId ASC, deviceId ASC, isRevoked ASC)
     securitySessions: (expiresAt ASC, isRevoked ASC)
     securitySessions: (lastActivity ASC, isRevoked ASC)

   Security Standards:
     · Device fingerprints stored server-side only, never returned to client
     · All state changes emit immutable audit log entries
     · HttpsError thrown for all client-visible errors (no stack leakage)
     · App Check enforced on every callable
     · Admin token claim required for cross-user operations
   ============================================================================ */
'use strict';

const { onCall, HttpsError }    = require('firebase-functions/v2/https');
const { onSchedule }            = require('firebase-functions/v2/scheduler');
const admin                     = require('firebase-admin');
const crypto                    = require('crypto');

/* ── Firebase references ─────────────────────────────────────────────────── */
const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp  = admin.firestore.Timestamp;

/* ── Shared Cloud Function options ───────────────────────────────────────── */
const CF_OPTIONS = {
  region:          'us-central1',
  enforceAppCheck: true,
  memory:          '256MiB',
  timeoutSeconds:  60,
};

const SCHED_OPTIONS = {
  region:   'us-central1',
  schedule: 'every 24 hours',
  timeZone: 'Africa/Nairobi',
  memory:   '256MiB',
};

/* ── Collection constants ────────────────────────────────────────────────── */
const COL = {
  SESSIONS: 'securitySessions',
  AUDIT:    'securityAuditLog',
};

/* ── Platform constants ──────────────────────────────────────────────────── */
const SESSION_TTL_DAYS          = 7;
const INACTIVITY_LIMIT_DAYS     = 30;
const IMPOSSIBLE_TRAVEL_MS      = 60 * 60 * 1000;  // 1 hour
const ROTATION_ABUSE_THRESHOLD  = 20;               // flag if rotated >20 times
const RISK_INCREMENT_HIGH       = 20;
const RISK_INCREMENT_MED        = 10;
const RISK_INCREMENT_LOW        = 5;

/* ── Role helpers ────────────────────────────────────────────────────────── */
/**
 * Throw HttpsError('unauthenticated') if no auth context present.
 */
function _requireAuth(auth) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
}

/**
 * Return true when the caller holds an elevated (admin/super_admin) claim.
 */
function _isElevated(auth) {
  return (
    auth?.token?.admin      === true ||
    auth?.token?.superAdmin === true ||
    auth?.token?.role === 'admin' ||
    auth?.token?.role === 'super_admin' ||
    auth?.token?.role === 4 ||
    auth?.token?.role === 5
  );
}

/* ── Structured logger ───────────────────────────────────────────────────── */
function _log(severity, message, meta = {}) {
  const entry = JSON.stringify({
    severity,
    message,
    module: 'security-session',
    ...meta,
  });
  if (severity === 'ERROR')   { console.error(entry); return; }
  if (severity === 'WARNING') { console.warn(entry);  return; }
  console.log(entry);
}

/* ── Immutable audit writer ──────────────────────────────────────────────── */
/**
 * Write an immutable entry to securityAuditLog.
 * Never throws — audit failures must not abort the primary operation.
 */
async function _audit(eventType, actorUid, targetUid, data = {}) {
  try {
    await db.collection(COL.AUDIT).add({
      eventType,
      actorUid:  actorUid  || 'system',
      targetUid: targetUid || actorUid || 'system',
      data,
      module:    'security-session',
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    _log('WARNING', 'Audit write failed', { eventType, actorUid, error: err.message });
  }
}

/* ── Per-session event writer ────────────────────────────────────────────── */
/**
 * Append a lightweight event to a session's subcollection trail.
 * Non-blocking — never throws.
 */
async function _sessionEvent(sessionId, eventType, data = {}) {
  try {
    await db.collection(COL.SESSIONS)
      .doc(sessionId)
      .collection('events')
      .add({
        eventType,
        data,
        ts: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    _log('WARNING', 'Session event write failed', { sessionId, eventType, error: err.message });
  }
}

/* ── Input sanitisation ──────────────────────────────────────────────────── */
/**
 * HTML-entity-encode and trim a string value.
 * Prevents XSS when values are later rendered in browser contexts.
 */
function _sanitize(s, maxLen = 256) {
  if (typeof s !== 'string') return String(s ?? '');
  return s
    .replace(/[<>"'&]/g, c => (
      { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c]
    ))
    .trim()
    .slice(0, maxLen);
}

/** Require a non-empty string or throw HttpsError. */
function _requireStr(val, field) {
  const s = _sanitize(String(val ?? ''), 500);
  if (!s) throw new HttpsError('invalid-argument', `${field} is required.`);
  return s;
}

/* ── User-agent parser ───────────────────────────────────────────────────── */
function _parseUA(ua) {
  const s = _sanitize(ua, 300);
  const browser = /Edg\//.test(s)     ? 'Edge'
    : /OPR\//.test(s)                 ? 'Opera'
    : /Chrome\//.test(s)              ? 'Chrome'
    : /Firefox\//.test(s)             ? 'Firefox'
    : /Safari\//.test(s)              ? 'Safari'
    :                                   'Unknown';
  const os = /Windows NT/.test(s)     ? 'Windows'
    : /Android/.test(s)               ? 'Android'
    : /iPhone|iPad/.test(s)           ? 'iOS'
    : /Macintosh/.test(s)             ? 'macOS'
    : /Linux/.test(s)                 ? 'Linux'
    :                                   'Unknown';
  return { browser, os };
}

/* ── Coarse geo lookup (IP → region) ─────────────────────────────────────── */
/**
 * Derive a rough country / city label from an IPv4 address without any
 * external API.  Based on IANA/APNIC/RIPE first-octet allocation heuristics.
 * For precise geo-IP, integrate MaxMind GeoLite2 or ip-api.com as a future
 * enhancement — store results in the same {country, city} fields.
 */
function _geoFromIp(ip) {
  if (!ip || typeof ip !== 'string') return { country: 'Unknown', city: 'Unknown' };
  const clean = ip.replace(/^::ffff:/, '');
  if (
    /^10\./.test(clean)    ||
    /^192\.168\./.test(clean) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(clean) ||
    clean === '127.0.0.1'  ||
    clean === '::1'
  ) return { country: 'Local', city: 'Local' };

  const first = parseInt(clean.split('.')[0], 10);
  if (isNaN(first)) return { country: 'Unknown', city: 'Unknown' };
  if (first >= 1   && first <= 50)  return { country: 'NA',      city: 'Unknown' };
  if (first >= 51  && first <= 80)  return { country: 'EU',      city: 'Unknown' };
  if (first >= 81  && first <= 100) return { country: 'AS',      city: 'Unknown' };
  if (first >= 101 && first <= 130) return { country: 'KE',      city: 'Nairobi' };
  if (first >= 131 && first <= 160) return { country: 'AF',      city: 'Unknown' };
  if (first >= 161 && first <= 200) return { country: 'AS',      city: 'Unknown' };
  if (first >= 201 && first <= 223) return { country: 'SA',      city: 'Unknown' };
  return { country: 'Unknown', city: 'Unknown' };
}

/* ── Impossible-travel heuristic ─────────────────────────────────────────── */
/**
 * Returns true when the IP changed AND the session is younger than
 * IMPOSSIBLE_TRAVEL_MS (1 hour).  A full geo-velocity check
 * (e.g. integrating with security-fraud-engine.checkImpossibleTravel)
 * can be wired here for production deployments.
 */
function _isImpossibleTravel(storedIp, currentIp, sessionCreatedAt) {
  if (!storedIp || !currentIp || storedIp === currentIp) return false;
  const sessionAgeMs = Date.now() - sessionCreatedAt.toMillis();
  return sessionAgeMs < IMPOSSIBLE_TRAVEL_MS;
}

/* ── Risk score capper ───────────────────────────────────────────────────── */
function _clampRisk(score) {
  return Math.min(Math.max(0, Math.round(score)), 100);
}

/* ── Client-safe session projection ─────────────────────────────────────── */
/** Strip raw deviceFingerprint before returning session data to client. */
function _toClientSession(data) {
  const { deviceFingerprint: _omit, ...safe } = data;  // eslint-disable-line no-unused-vars
  return safe;
}

/* ============================================================================
   1. createSession
   Called immediately after successful client-side sign-in.
   ============================================================================ */
exports.createSession = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const uid = req.auth.uid;

  const deviceId          = _requireStr(req.data?.deviceId,          'deviceId');
  const deviceFingerprint = _sanitize(req.data?.deviceFingerprint  ?? '', 200);
  const userAgent         = _sanitize(req.data?.userAgent           ?? '', 300);
  const ip                = _sanitize(req.data?.ip                  ?? req.rawRequest?.ip ?? '', 45);
  const loginMethod       = _requireStr(req.data?.loginMethod,       'loginMethod');

  const { browser, os }    = _parseUA(userAgent);
  const { country, city }  = _geoFromIp(ip);
  const sessionId          = crypto.randomUUID();
  const now                = Timestamp.now();
  const expiresAt          = Timestamp.fromMillis(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await db.collection(COL.SESSIONS).doc(sessionId).set({
    userId:             uid,
    sessionId,
    deviceId,
    deviceFingerprint,      // server-side only — stripped before returning to client
    browser,
    os,
    userAgent,
    ip,
    country,
    city,
    riskScore:          0,
    loginMethod,
    createdAt:          now,
    lastActivity:       now,
    expiresAt,
    rotationCount:      0,
    isActive:           true,
    isRevoked:          false,
  });

  await Promise.all([
    _audit('SESSION_CREATED', uid, uid, { sessionId, deviceId, loginMethod, ip, country }),
    _sessionEvent(sessionId, 'CREATED', { loginMethod, ip, browser, os }),
  ]);

  _log('INFO', 'Session created', { uid, sessionId, loginMethod, country });
  return { sessionId, expiresAt: expiresAt.toMillis() };
});

/* ============================================================================
   2. validateSession
   Check validity + detect IP anomaly. Called before privileged operations.
   ============================================================================ */
exports.validateSession = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const uid       = req.auth.uid;
  const sessionId = _requireStr(req.data?.sessionId, 'sessionId');
  const currentIp = _sanitize(req.data?.ip ?? '', 45);

  const snap = await db.collection(COL.SESSIONS).doc(sessionId).get();
  if (!snap.exists) return { valid: false, reason: 'SESSION_NOT_FOUND' };

  const session = snap.data();

  if (session.userId !== uid) {
    await _audit('SESSION_VALIDATE_UNAUTHORIZED', uid, session.userId, { sessionId });
    return { valid: false, reason: 'SESSION_OWNERSHIP_MISMATCH' };
  }
  if (session.isRevoked)                                 return { valid: false, reason: 'SESSION_REVOKED'  };
  if (session.expiresAt.toMillis() < Date.now())         return { valid: false, reason: 'SESSION_EXPIRED'  };

  let anomalyDetected = false;
  let anomalyType     = null;
  let riskScore       = session.riskScore || 0;

  if (currentIp && _isImpossibleTravel(session.ip, currentIp, session.createdAt)) {
    anomalyDetected = true;
    anomalyType     = 'IMPOSSIBLE_TRAVEL';
    riskScore       = _clampRisk(riskScore + RISK_INCREMENT_HIGH);

    await db.collection(COL.SESSIONS).doc(sessionId).update({
      riskScore,
      lastAnomalyAt:   FieldValue.serverTimestamp(),
      lastAnomalyType: anomalyType,
    });

    await Promise.all([
      _audit('SESSION_ANOMALY_DETECTED', uid, uid, {
        sessionId, anomalyType, previousIp: session.ip, currentIp, riskScore,
      }),
      _sessionEvent(sessionId, 'ANOMALY_DETECTED', { anomalyType, riskScore }),
    ]);
  }

  await db.collection(COL.SESSIONS).doc(sessionId).update({
    lastActivity: FieldValue.serverTimestamp(),
  });

  _log('INFO', 'Session validated', { uid, sessionId, anomalyDetected, riskScore });
  return {
    valid: true,
    sessionId,
    anomalyDetected,
    ...(anomalyType && { anomalyType }),
    riskScore,
  };
});

/* ============================================================================
   3. rotateSession
   Prevent session fixation: revoke old ID, issue new one.
   ============================================================================ */
exports.rotateSession = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const uid       = req.auth.uid;
  const sessionId = _requireStr(req.data?.sessionId, 'sessionId');

  const snap = await db.collection(COL.SESSIONS).doc(sessionId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Session not found.');

  const session = snap.data();
  if (session.userId !== uid)              throw new HttpsError('permission-denied', 'Session does not belong to caller.');
  if (session.isRevoked)                   throw new HttpsError('failed-precondition', 'Session is already revoked.');
  if (session.expiresAt.toMillis() < Date.now()) throw new HttpsError('failed-precondition', 'Session has expired.');

  const newSessionId = crypto.randomUUID();
  const now          = Timestamp.now();
  const expiresAt    = Timestamp.fromMillis(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  const newSession = {
    ...session,
    sessionId:      newSessionId,
    createdAt:      now,
    lastActivity:   now,
    expiresAt,
    rotationCount:  (session.rotationCount || 0) + 1,
    isActive:       true,
    isRevoked:      false,
    rotatedFrom:    sessionId,
  };

  const batch = db.batch();
  batch.set(
    db.collection(COL.SESSIONS).doc(newSessionId),
    newSession,
  );
  batch.update(
    db.collection(COL.SESSIONS).doc(sessionId),
    {
      isRevoked:  true,
      isActive:   false,
      revokedAt:  FieldValue.serverTimestamp(),
      revokedBy:  uid,
      rotatedTo:  newSessionId,
    },
  );
  await batch.commit();

  await Promise.all([
    _audit('SESSION_ROTATED', uid, uid, { oldSessionId: sessionId, newSessionId }),
    _sessionEvent(newSessionId, 'ROTATED_FROM', { previousSessionId: sessionId }),
  ]);

  _log('INFO', 'Session rotated', { uid, oldSessionId: sessionId, newSessionId });
  return { newSessionId, expiresAt: expiresAt.toMillis() };
});

/* ============================================================================
   4. terminateSession
   Immediately revoke a specific session by ID.
   ============================================================================ */
exports.terminateSession = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const uid       = req.auth.uid;
  const sessionId = _requireStr(req.data?.sessionId, 'sessionId');

  const snap = await db.collection(COL.SESSIONS).doc(sessionId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Session not found.');

  const session = snap.data();

  if (session.userId !== uid && !_isElevated(req.auth)) {
    await _audit('SESSION_TERMINATE_UNAUTHORIZED', uid, session.userId, { sessionId });
    throw new HttpsError('permission-denied', 'Cannot terminate another user\'s session.');
  }

  await db.collection(COL.SESSIONS).doc(sessionId).update({
    isRevoked:  true,
    isActive:   false,
    revokedAt:  FieldValue.serverTimestamp(),
    revokedBy:  uid,
  });

  await Promise.all([
    _audit('SESSION_TERMINATED', uid, session.userId, { sessionId }),
    _sessionEvent(sessionId, 'TERMINATED', { revokedBy: uid }),
  ]);

  _log('INFO', 'Session terminated', { actorUid: uid, sessionId, targetUid: session.userId });
  return { ok: true };
});

/* ============================================================================
   5. terminateAllSessions
   Remote logout: revoke every active session for a given userId.
   Admin can target any userId; non-admin can only target themselves.
   ============================================================================ */
exports.terminateAllSessions = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const callerUid    = req.auth.uid;
  const targetUserId = _sanitize(req.data?.userId ?? callerUid, 128) || callerUid;

  if (targetUserId !== callerUid && !_isElevated(req.auth)) {
    await _audit('SESSION_TERMINATE_ALL_UNAUTHORIZED', callerUid, targetUserId, {});
    throw new HttpsError('permission-denied', 'Cannot terminate sessions for another user.');
  }

  const snap = await db.collection(COL.SESSIONS)
    .where('userId',    '==', targetUserId)
    .where('isRevoked', '==', false)
    .get();

  if (snap.empty) return { revokedCount: 0 };

  const BATCH_LIMIT = 400;
  let revokedCount  = 0;

  for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const slice = snap.docs.slice(i, i + BATCH_LIMIT);
    for (const doc of slice) {
      batch.update(doc.ref, {
        isRevoked:  true,
        isActive:   false,
        revokedAt:  FieldValue.serverTimestamp(),
        revokedBy:  callerUid,
      });
    }
    await batch.commit();
    revokedCount += slice.length;
  }

  await _audit('SESSION_TERMINATE_ALL', callerUid, targetUserId, { revokedCount });
  _log('INFO', 'All sessions terminated', { callerUid, targetUserId, revokedCount });
  return { revokedCount };
});

/* ============================================================================
   6. getUserSessions
   List all active (non-revoked) sessions for the authenticated user.
   Raw deviceFingerprint is stripped before returning.
   ============================================================================ */
exports.getUserSessions = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const uid = req.auth.uid;

  const snap = await db.collection(COL.SESSIONS)
    .where('userId',    '==', uid)
    .where('isRevoked', '==', false)
    .orderBy('lastActivity', 'desc')
    .get();

  const sessions = snap.docs.map(doc => _toClientSession(doc.data()));
  return { sessions };
});

/* ============================================================================
   7. revokeDeviceSessions
   Revoke all active sessions for a specific deviceId owned by the caller.
   ============================================================================ */
exports.revokeDeviceSessions = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const uid      = req.auth.uid;
  const deviceId = _requireStr(req.data?.deviceId, 'deviceId');

  const snap = await db.collection(COL.SESSIONS)
    .where('userId',    '==', uid)
    .where('deviceId',  '==', deviceId)
    .where('isRevoked', '==', false)
    .get();

  if (snap.empty) return { revokedCount: 0 };

  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      isRevoked:  true,
      isActive:   false,
      revokedAt:  FieldValue.serverTimestamp(),
      revokedBy:  uid,
    });
  }
  await batch.commit();

  const revokedCount = snap.size;
  await _audit('DEVICE_SESSIONS_REVOKED', uid, uid, { deviceId, revokedCount });
  _log('INFO', 'Device sessions revoked', { uid, deviceId, revokedCount });
  return { revokedCount };
});

/* ============================================================================
   8. updateSessionActivity
   Lightweight heartbeat — called every ~5 minutes by the client SDK.
   Returns quickly to minimise latency impact on the caller.
   ============================================================================ */
exports.updateSessionActivity = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const uid       = req.auth.uid;
  const sessionId = _requireStr(req.data?.sessionId, 'sessionId');

  const ref  = db.collection(COL.SESSIONS).doc(sessionId);
  const snap = await ref.get();

  if (!snap.exists)                               return { ok: false, reason: 'SESSION_NOT_FOUND' };
  if (snap.data().userId !== uid)                 return { ok: false, reason: 'SESSION_OWNERSHIP_MISMATCH' };
  if (snap.data().isRevoked)                      return { ok: false, reason: 'SESSION_REVOKED'  };
  if (snap.data().expiresAt.toMillis() < Date.now()) return { ok: false, reason: 'SESSION_EXPIRED'  };

  await ref.update({ lastActivity: FieldValue.serverTimestamp() });
  return { ok: true };
});

/* ============================================================================
   9. detectSessionAnomaly
   Deep anomaly analysis: impossible travel, fingerprint mismatch, rotation
   abuse, and TTL overage. Admin can analyse any session; users only their own.
   ============================================================================ */
exports.detectSessionAnomaly = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);
  const callerUid         = req.auth.uid;
  const sessionId         = _requireStr(req.data?.sessionId, 'sessionId');
  const currentIp         = _sanitize(req.data?.ip                 ?? '', 45);
  const currentFingerprint = _sanitize(req.data?.deviceFingerprint ?? '', 200);

  const snap = await db.collection(COL.SESSIONS).doc(sessionId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Session not found.');

  const session = snap.data();
  if (session.userId !== callerUid && !_isElevated(req.auth)) {
    await _audit('SESSION_ANOMALY_UNAUTHORIZED', callerUid, session.userId, { sessionId });
    throw new HttpsError('permission-denied', 'Cannot inspect another user\'s session.');
  }

  const anomalies = [];
  let riskScore   = session.riskScore || 0;

  /* ── Check 1: Impossible travel ──────────────────────────────────── */
  if (currentIp && session.ip && currentIp !== session.ip) {
    const ageMin = Math.round((Date.now() - session.createdAt.toMillis()) / 60_000);
    if (_isImpossibleTravel(session.ip, currentIp, session.createdAt)) {
      anomalies.push({
        type:     'IMPOSSIBLE_TRAVEL',
        detail:   `IP changed from ${session.ip} to ${currentIp} within ${ageMin} min of session creation`,
        severity: 'HIGH',
      });
      riskScore = _clampRisk(riskScore + RISK_INCREMENT_HIGH);
    } else {
      anomalies.push({
        type:     'IP_CHANGED',
        detail:   `IP changed from ${session.ip} to ${currentIp} after ${ageMin} min`,
        severity: 'LOW',
      });
      riskScore = _clampRisk(riskScore + RISK_INCREMENT_LOW);
    }
  }

  /* ── Check 2: Device fingerprint mismatch ────────────────────────── */
  if (currentFingerprint && session.deviceFingerprint &&
      currentFingerprint !== session.deviceFingerprint) {
    anomalies.push({
      type:     'FINGERPRINT_MISMATCH',
      detail:   'Device fingerprint does not match the original session record',
      severity: 'HIGH',
    });
    riskScore = _clampRisk(riskScore + RISK_INCREMENT_HIGH);
  }

  /* ── Check 3: Excessive rotation (token harvesting signal) ──────── */
  if ((session.rotationCount || 0) > ROTATION_ABUSE_THRESHOLD) {
    anomalies.push({
      type:     'EXCESSIVE_ROTATION',
      detail:   `Session rotated ${session.rotationCount} times — possible token harvesting attempt`,
      severity: 'MEDIUM',
    });
    riskScore = _clampRisk(riskScore + RISK_INCREMENT_MED);
  }

  /* ── Check 4: Session past TTL but not yet cleaned ───────────────── */
  if (session.expiresAt.toMillis() < Date.now()) {
    anomalies.push({
      type:     'SESSION_OVERDUE',
      detail:   'Session TTL exceeded but not yet marked revoked by cleanup sweep',
      severity: 'LOW',
    });
    riskScore = _clampRisk(riskScore + RISK_INCREMENT_LOW);
  }

  if (anomalies.length > 0) {
    await db.collection(COL.SESSIONS).doc(sessionId).update({
      riskScore,
      lastAnomalyAt:   FieldValue.serverTimestamp(),
      lastAnomalyType: anomalies[0].type,
    });
    await Promise.all([
      _audit('SESSION_ANOMALY_ANALYSIS', callerUid, session.userId, {
        sessionId, anomalies, riskScore,
      }),
      _sessionEvent(sessionId, 'ANOMALY_ANALYSIS', { anomalies, riskScore }),
    ]);
  }

  _log('INFO', 'Session anomaly analysis complete', {
    callerUid, sessionId, anomalyCount: anomalies.length, riskScore,
  });
  return { anomalies, riskScore };
});

/* ============================================================================
   10. scheduledSessionCleanup
   Runs every 24 hours.  Marks as revoked:
     a) Sessions where expiresAt < now
     b) Sessions where lastActivity < now - 30 days (inactivity)
   Batches writes in groups of 400 to stay within Firestore batch limits.
   ============================================================================ */
exports.scheduledSessionCleanup = onSchedule(SCHED_OPTIONS, async () => {
  const now             = Timestamp.now();
  const inactivityCutoff = Timestamp.fromMillis(
    Date.now() - INACTIVITY_LIMIT_DAYS * 86_400_000,
  );

  const [expiredSnap, inactiveSnap] = await Promise.all([
    db.collection(COL.SESSIONS)
      .where('expiresAt',   '<', now)
      .where('isRevoked',   '==', false)
      .get(),
    db.collection(COL.SESSIONS)
      .where('lastActivity', '<', inactivityCutoff)
      .where('isRevoked',    '==', false)
      .get(),
  ]);

  /* Deduplicate docs that appear in both result sets */
  const docsMap = new Map();
  for (const doc of [...expiredSnap.docs, ...inactiveSnap.docs]) {
    docsMap.set(doc.id, doc);
  }

  if (docsMap.size === 0) {
    _log('INFO', 'Scheduled cleanup: nothing to clean.');
    return;
  }

  const BATCH_LIMIT = 400;
  const allDocs     = Array.from(docsMap.values());
  let cleanedCount  = 0;

  for (let i = 0; i < allDocs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const slice = allDocs.slice(i, i + BATCH_LIMIT);
    for (const doc of slice) {
      batch.update(doc.ref, {
        isRevoked:  true,
        isActive:   false,
        revokedAt:  FieldValue.serverTimestamp(),
        revokedBy:  'system:cleanup',
      });
    }
    await batch.commit();
    cleanedCount += slice.length;
  }

  await _audit('SESSION_CLEANUP_RUN', 'system', 'system', {
    cleanedCount,
    ranAt: now.toDate().toISOString(),
  });

  _log('INFO', 'Scheduled cleanup complete', { cleanedCount });
});
