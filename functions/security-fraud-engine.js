/* ================================================================
   SOKONI PLATFORM — SECURITY & FRAUD ENGINE  v1.0.0  |  2026-06-28
   functions/security-fraud-engine.js

   Configurable, multi-signal fraud detection engine.
   Covers velocity checks, impossible travel, device trust,
   behavioral scoring, alert lifecycle, and automated sweeps.

   Collections used:
     securityEvents/{auto-id}             — raw event log
     securityAlerts/{auto-id}             — open/resolved alerts
     securityRisk/{userId}                — per-user risk profile + last location
     securityDevices/{userId}/devices/{deviceId} — device trust registry
     sellers/{sellerId}                   — seller profile (new-seller check)
     securityAuditLog/{auto-id}           — sweep and admin audit trail

   Risk score semantics:
     0-30   Low      → allow
     31-60  Medium   → monitor / soft challenge
     61-80  High     → challenge (step-up auth / manual review)
     81-100 Critical → block + alert

   Exports (9 CFs):
     recordSecurityEvent   — ingest any platform security event
     checkImpossibleTravel — geo-velocity anomaly detection
     checkPaymentVelocity  — rate-based payment fraud detection
     scoreFraudRisk        — composite multi-signal scoring
     getFraudAlerts        — list/filter alerts (admin or own)
     dismissFraudAlert     — admin: dismiss an alert
     escalateFraudAlert    — admin: escalate alert to incident
     getFraudReport        — admin: aggregate fraud analytics
     scheduledFraudSweep   — hourly scheduled pattern scan
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');

const FieldValue = admin.firestore.FieldValue;
const db         = () => admin.firestore();

/* ── Shared CF options ──────────────────────────────────────────── */
const CF_OPTIONS = { region: 'us-central1', enforceAppCheck: true };

/* ── Role constants ─────────────────────────────────────────────── */
const ROLE = {
  cashier: 0, supervisor: 1, manager: 2,
  owner: 3, admin: 4, super_admin: 5,
};

/* ── Enumerations ───────────────────────────────────────────────── */
const VALID_EVENT_TYPES = new Set([
  'login_success', 'login_fail', 'payment_attempt', 'payment_fail',
  'suspicious_request', 'mfa_fail', 'session_anomaly', 'device_change',
  'privilege_access', 'data_export',
]);

const VALID_SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);

const ALERT_TRIGGER_SEVERITIES = new Set(['high', 'critical']);

/* ── Auth helpers ───────────────────────────────────────────────── */
function _requireAuth(auth) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
}

function _requireRole(auth, minRole) {
  _requireAuth(auth);
  const r     = auth.token?.role;
  const level = typeof r === 'number' ? r : (ROLE[r] ?? 0);
  if (level < minRole) throw new HttpsError('permission-denied', 'Insufficient role.');
}

function _isElevated(auth) {
  return ['admin', 'super_admin', 4, 5].includes(auth?.token?.role) ||
    auth?.token?.admin === true ||
    auth?.token?.superAdmin === true;
}

function _requireAdmin(auth) {
  _requireAuth(auth);
  if (!_isElevated(auth)) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
}

/* ── Input sanitisation ─────────────────────────────────────────── */
function _san(val, maxLen = 200) {
  if (typeof val !== 'string') return '';
  return val.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

/* ── Haversine distance (km) ────────────────────────────────────── */
/**
 * Calculate great-circle distance between two geo-coordinates.
 * Returns distance in kilometres.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Internal alert writer ──────────────────────────────────────── */
/**
 * Write a single securityAlert document.
 * Returns the new alert doc ID.
 */
async function _createAlert(firestore, { userId, type, severity, metadata = {} }) {
  const alertRef = firestore.collection('securityAlerts').doc();
  const alertId  = alertRef.id;
  await alertRef.set({
    alertId,
    userId,
    type,
    severity,
    status:    'open',
    createdAt: FieldValue.serverTimestamp(),
    metadata,
    resolvedAt: null,
    resolvedBy: null,
  });
  return alertId;
}

/* ── Risk-score capper ──────────────────────────────────────────── */
function _capScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ── Risk level labeller ────────────────────────────────────────── */
function _riskLevel(score) {
  if (score <= 30) return 'Low';
  if (score <= 60) return 'Medium';
  if (score <= 80) return 'High';
  return 'Critical';
}

/* ── Recommendation mapper ──────────────────────────────────────── */
function _recommendation(score) {
  if (score <= 30) return 'allow';
  if (score <= 60) return 'review';
  if (score <= 80) return 'challenge';
  return 'block';
}

/* ── Structured logger ──────────────────────────────────────────── */
function _log(severity, message, meta = {}) {
  const entry = JSON.stringify({ severity, message, service: 'security-fraud-engine', ...meta });
  if (severity === 'ERROR')   console.error(entry);
  else if (severity === 'WARNING') console.warn(entry);
  else                             console.log(entry);
}

/* ================================================================
   1. recordSecurityEvent
   Ingest any platform security event; auto-create alert for
   high/critical severity events.
================================================================ */
exports.recordSecurityEvent = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);

  const {
    userId,
    eventType,
    metadata   = {},
    ipAddress  = '',
    deviceId   = '',
    severity   = 'info',
  } = req.data;

  /* ── Input validation ─────────────────────────────────────────── */
  if (!userId)                          throw new HttpsError('invalid-argument', 'userId is required.');
  if (!VALID_EVENT_TYPES.has(eventType)) throw new HttpsError('invalid-argument', `Invalid eventType: ${eventType}`);
  if (!VALID_SEVERITIES.has(severity))   throw new HttpsError('invalid-argument', `Invalid severity: ${severity}`);

  /* Callers may only record events for themselves unless admin. */
  if (req.auth.uid !== userId && !_isElevated(req.auth)) {
    throw new HttpsError('permission-denied', 'Cannot record events for another user.');
  }

  const firestore = db();
  const eventRef  = firestore.collection('securityEvents').doc();
  const eventId   = eventRef.id;

  await eventRef.set({
    eventId,
    userId,
    eventType,
    severity,
    ipAddress:  _san(ipAddress, 50),
    deviceId:   _san(deviceId, 128),
    metadata,
    createdAt:  FieldValue.serverTimestamp(),
  });

  /* ── Alert for high/critical ──────────────────────────────────── */
  let alertCreated = false;
  if (ALERT_TRIGGER_SEVERITIES.has(severity)) {
    await _createAlert(firestore, {
      userId,
      type:     eventType,
      severity,
      metadata: { eventId, ipAddress: _san(ipAddress, 50), ...metadata },
    });
    alertCreated = true;
  }

  _log('INFO', 'Security event recorded', { eventId, userId, eventType, severity, alertCreated });

  return { eventId, alertCreated };
});

/* ================================================================
   2. checkImpossibleTravel
   Compares current login location against last known location.
   Flags impossible travel (> 500 km in < 2 hours).
================================================================ */
exports.checkImpossibleTravel = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);

  const {
    userId,
    ipAddress,
    latitude,
    longitude,
    timestamp,
  } = req.data;

  if (!userId)    throw new HttpsError('invalid-argument', 'userId is required.');
  if (!ipAddress) throw new HttpsError('invalid-argument', 'ipAddress is required.');
  if (req.auth.uid !== userId && !_isElevated(req.auth)) {
    throw new HttpsError('permission-denied', 'Cannot check travel for another user.');
  }

  const firestore    = db();
  const riskRef      = firestore.doc(`securityRisk/${userId}`);
  const riskSnap     = await riskRef.get();
  const riskData     = riskSnap.data() || {};
  const lastLocation = riskData.lastLocation || null;

  const currentTs    = timestamp ? new Date(timestamp).getTime() : Date.now();
  const currentLat   = typeof latitude  === 'number' ? latitude  : null;
  const currentLon   = typeof longitude === 'number' ? longitude : null;

  let impossibleTravel = false;
  let distanceKm       = null;
  let alertId          = null;

  /* ── Geo-velocity check ───────────────────────────────────────── */
  if (
    lastLocation &&
    currentLat !== null &&
    currentLon !== null &&
    typeof lastLocation.latitude  === 'number' &&
    typeof lastLocation.longitude === 'number' &&
    typeof lastLocation.timestamp === 'number'
  ) {
    const elapsedMs  = currentTs - lastLocation.timestamp;
    const elapsedHrs = elapsedMs / (1000 * 60 * 60);

    if (elapsedHrs < 2) {
      distanceKm = haversineKm(
        lastLocation.latitude,
        lastLocation.longitude,
        currentLat,
        currentLon,
      );

      if (distanceKm > 500) {
        impossibleTravel = true;

        /* Create critical alert */
        alertId = await _createAlert(firestore, {
          userId,
          type:     'impossible_travel',
          severity: 'critical',
          metadata: {
            distanceKm:    Math.round(distanceKm),
            elapsedHrs:    Math.round(elapsedHrs * 10) / 10,
            fromIp:        lastLocation.ip  || '',
            toIp:          _san(ipAddress, 50),
            fromCity:      lastLocation.city    || '',
            fromCountry:   lastLocation.country || '',
          },
        });

        /* Increment risk score (capped at 100) */
        const currentScore  = typeof riskData.riskScore === 'number' ? riskData.riskScore : 0;
        const newScore      = _capScore(currentScore + 40);
        await riskRef.set(
          { riskScore: newScore, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );

        _log('WARNING', 'Impossible travel detected', { userId, distanceKm: Math.round(distanceKm), alertId });
      }
    }
  }

  /* ── Update last known location ───────────────────────────────── */
  const newLocation = {
    ip:        _san(ipAddress, 50),
    latitude:  currentLat,
    longitude: currentLon,
    country:   _san(req.data.country  || '', 64),
    city:      _san(req.data.city     || '', 64),
    timestamp: currentTs,
  };

  await riskRef.set(
    { lastLocation: newLocation, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  return {
    impossibleTravel,
    distanceKm: distanceKm !== null ? Math.round(distanceKm) : null,
    alert:      alertId,
  };
});

/* ================================================================
   3. checkPaymentVelocity
   Rate-based payment fraud detection.
   Rules:
     - > 5 payments in 1 minute
     - > 20 payments in 1 hour
     - > 3 payments > KES 50,000 in 1 hour
     - Same amount paid 3+ times in 10 minutes (duplicate suspicion)
================================================================ */
exports.checkPaymentVelocity = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);

  const { userId, sellerId, amount, currency = 'KES' } = req.data;

  if (!userId) throw new HttpsError('invalid-argument', 'userId is required.');
  if (typeof amount !== 'number' || amount <= 0) {
    throw new HttpsError('invalid-argument', 'amount must be a positive number.');
  }
  if (req.auth.uid !== userId && !_isElevated(req.auth)) {
    throw new HttpsError('permission-denied', 'Cannot check velocity for another user.');
  }

  const firestore = db();
  const now       = Date.now();

  /* ── Fetch recent payment_attempt events ──────────────────────── */
  const oneHourAgo  = new Date(now - 60 * 60 * 1000);
  const eventsSnap  = await firestore
    .collection('securityEvents')
    .where('userId',    '==', userId)
    .where('eventType', '==', 'payment_attempt')
    .where('createdAt', '>=', oneHourAgo)
    .orderBy('createdAt', 'asc')
    .get();

  const events      = eventsSnap.docs.map(d => {
    const data = d.data();
    /* createdAt can be a Firestore Timestamp or already converted */
    const ts = data.createdAt?.toMillis
      ? data.createdAt.toMillis()
      : (data.createdAt?._seconds ? data.createdAt._seconds * 1000 : now);
    return { ...data, tsMs: ts };
  });

  const oneMinuteAgo  = now - 60 * 1000;
  const tenMinutesAgo = now - 10 * 60 * 1000;

  const inLastMinute  = events.filter(e => e.tsMs >= oneMinuteAgo);
  const inLastHour    = events; /* Already filtered to last hour */
  const highValue     = inLastHour.filter(e =>
    typeof e.metadata?.amount === 'number' && e.metadata.amount > 50000,
  );
  const sameAmountInTen = events.filter(e =>
    e.tsMs >= tenMinutesAgo &&
    typeof e.metadata?.amount === 'number' &&
    Math.abs(e.metadata.amount - amount) < 0.01,
  );

  /* ── Evaluate rules ───────────────────────────────────────────── */
  const flags      = [];
  let   riskScore  = 0;

  if (inLastMinute.length > 5) {
    flags.push(`velocity_1min: ${inLastMinute.length} payments in last 60 seconds`);
    riskScore += 35;
  }
  if (inLastHour.length > 20) {
    flags.push(`velocity_1hr: ${inLastHour.length} payments in last hour`);
    riskScore += 25;
  }
  if (highValue.length > 3) {
    flags.push(`high_value_velocity: ${highValue.length} payments > KES 50,000 in last hour`);
    riskScore += 30;
  }
  if (sameAmountInTen.length >= 3) {
    flags.push(`duplicate_suspicion: same amount (${amount}) seen ${sameAmountInTen.length} times in 10 minutes`);
    riskScore += 20;
  }

  riskScore      = _capScore(riskScore);
  const allowed  = flags.length === 0;

  /* ── Write alert if blocked ───────────────────────────────────── */
  if (!allowed) {
    await _createAlert(firestore, {
      userId,
      type:     'payment_velocity',
      severity: riskScore >= 60 ? 'high' : 'medium',
      metadata: { flags, riskScore, amount, currency, sellerId: sellerId || '' },
    });

    _log('WARNING', 'Payment velocity limit exceeded', { userId, flags, riskScore });
  }

  return { allowed, flags, riskScore };
});

/* ================================================================
   4. scoreFraudRisk
   Composite multi-signal fraud scorer.
   Aggregates device trust, open alerts, seller age, velocity,
   transaction size, and base risk profile.
================================================================ */
exports.scoreFraudRisk = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);

  const {
    userId,
    sellerId   = '',
    amount     = 0,
    deviceId   = '',
    ipAddress  = '',
    actionType = 'payment',
  } = req.data;

  if (!userId) throw new HttpsError('invalid-argument', 'userId is required.');
  if (req.auth.uid !== userId && !_isElevated(req.auth)) {
    throw new HttpsError('permission-denied', 'Cannot score risk for another user.');
  }

  const firestore = db();
  const signals   = [];
  let   score     = 0;

  /* ── 1. Base risk score from securityRisk profile ─────────────── */
  const riskSnap = await firestore.doc(`securityRisk/${userId}`).get();
  const riskData = riskSnap.data() || {};
  const baseScore = typeof riskData.riskScore === 'number' ? riskData.riskScore : 0;
  score          += baseScore * 0.4; /* 40% weight on historical base */
  if (baseScore > 0) signals.push(`base_risk_score: ${baseScore}`);

  /* ── 2. Device trust score ────────────────────────────────────── */
  let deviceTrustScore = 50; /* Default: neutral */
  if (deviceId) {
    try {
      const deviceSnap = await firestore
        .doc(`securityDevices/${userId}/devices/${deviceId}`)
        .get();
      if (deviceSnap.exists) {
        const dev = deviceSnap.data();
        if (dev.blocked) {
          score += 40;
          signals.push('blocked_device');
        } else if (dev.trusted) {
          deviceTrustScore = dev.trustScore ?? 80;
        } else {
          /* Device exists but not explicitly trusted */
          deviceTrustScore = dev.trustScore ?? 40;
          score           += 20;
          signals.push('unrecognized_device');
        }
      } else {
        /* Device never seen — treat as unrecognized */
        score += 20;
        signals.push('unknown_device');
      }
    } catch (err) {
      _log('WARNING', 'Device trust lookup failed', { userId, deviceId, err: err.message });
    }
  } else {
    score += 10;
    signals.push('no_device_id_provided');
  }
  /* Low device trust score adds risk */
  if (deviceTrustScore < 40) {
    score += 15;
    signals.push(`low_device_trust: ${deviceTrustScore}`);
  }

  /* ── 3. Open fraud alerts count ───────────────────────────────── */
  const openAlertsSnap = await firestore
    .collection('securityAlerts')
    .where('userId', '==', userId)
    .where('status', '==', 'open')
    .get();
  const openAlertsCount = openAlertsSnap.size;
  if (openAlertsCount > 0) {
    const alertBoost = Math.min(openAlertsCount * 8, 30);
    score           += alertBoost;
    signals.push(`open_alerts: ${openAlertsCount} (+${alertBoost})`);
  }

  /* ── 4. New seller risk ───────────────────────────────────────── */
  if (sellerId) {
    try {
      const sellerSnap = await firestore.doc(`sellers/${sellerId}`).get();
      if (sellerSnap.exists) {
        const seller  = sellerSnap.data();
        const created = seller.createdAt?.toMillis
          ? seller.createdAt.toMillis()
          : (seller.createdAt?._seconds ? seller.createdAt._seconds * 1000 : 0);
        const ageMs   = Date.now() - created;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays < 7) {
          score += 15;
          signals.push(`new_seller: ${Math.round(ageDays)} days old`);
        }
      }
    } catch (err) {
      _log('WARNING', 'Seller age lookup failed', { sellerId, err: err.message });
    }
  }

  /* ── 5. Payment velocity check (inline logic) ─────────────────── */
  if (actionType === 'payment' || actionType === 'payment_attempt') {
    const oneHourAgo   = new Date(Date.now() - 60 * 60 * 1000);
    const velocitySnap = await firestore
      .collection('securityEvents')
      .where('userId',    '==', userId)
      .where('eventType', '==', 'payment_attempt')
      .where('createdAt', '>=', oneHourAgo)
      .get();
    const velocityCount = velocitySnap.size;
    if (velocityCount > 20) {
      score += 20;
      signals.push(`high_payment_velocity: ${velocityCount} in last hour`);
    } else if (velocityCount > 10) {
      score += 10;
      signals.push(`elevated_payment_velocity: ${velocityCount} in last hour`);
    }
  }

  /* ── 6. High transaction value ────────────────────────────────── */
  if (typeof amount === 'number' && amount > 100000) {
    score += 10;
    signals.push(`high_value_transaction: KES ${amount}`);
  }

  /* ── Finalise score ───────────────────────────────────────────── */
  const fraudScore   = _capScore(score);
  const riskLevel    = _riskLevel(fraudScore);
  const recommendation = _recommendation(fraudScore);

  /* ── Write critical alert ─────────────────────────────────────── */
  if (fraudScore >= 80) {
    await _createAlert(firestore, {
      userId,
      type:     'high_fraud_score',
      severity: 'critical',
      metadata: { fraudScore, signals, actionType, amount, deviceId: _san(deviceId, 128), ipAddress: _san(ipAddress, 50) },
    });
    _log('WARNING', 'Critical fraud score computed', { userId, fraudScore, signals });
  }

  return { fraudScore, riskLevel, recommendation, signals };
});

/* ================================================================
   5. getFraudAlerts
   List / filter securityAlerts.
   Admins see all alerts; regular users see only their own.
================================================================ */
exports.getFraudAlerts = onCall(CF_OPTIONS, async (req) => {
  _requireAuth(req.auth);

  const {
    status,
    severity,
    limit     = 50,
    startDate,
    endDate,
  } = req.data;

  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const firestore = db();
  const isAdmin   = _isElevated(req.auth);

  let query = firestore.collection('securityAlerts').orderBy('createdAt', 'desc');

  /* Scope non-admins to their own alerts */
  if (!isAdmin) {
    query = query.where('userId', '==', req.auth.uid);
  }

  if (status)    query = query.where('status',   '==', status);
  if (severity)  query = query.where('severity', '==', severity);

  if (startDate) {
    const start = new Date(startDate);
    if (!isNaN(start.getTime())) query = query.where('createdAt', '>=', start);
  }
  if (endDate) {
    const end = new Date(endDate);
    if (!isNaN(end.getTime())) query = query.where('createdAt', '<=', end);
  }

  const snap   = await query.limit(safeLimit).get();
  const alerts = snap.docs.map(d => d.data());

  return { alerts, count: alerts.length };
});

/* ================================================================
   6. dismissFraudAlert
   Admin-only: mark an alert as dismissed with resolution notes.
================================================================ */
exports.dismissFraudAlert = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { alertId, resolution, notes = '' } = req.data;

  if (!alertId)    throw new HttpsError('invalid-argument', 'alertId is required.');
  if (!resolution) throw new HttpsError('invalid-argument', 'resolution is required.');

  const firestore = db();
  const alertRef  = firestore.doc(`securityAlerts/${alertId}`);
  const alertSnap = await alertRef.get();

  if (!alertSnap.exists) throw new HttpsError('not-found', `Alert ${alertId} not found.`);
  if (alertSnap.data().status === 'dismissed') {
    throw new HttpsError('failed-precondition', 'Alert is already dismissed.');
  }

  await alertRef.update({
    status:     'dismissed',
    resolvedAt: FieldValue.serverTimestamp(),
    resolvedBy: req.auth.uid,
    resolution: _san(resolution, 200),
    notes:      _san(notes, 500),
  });

  await firestore.collection('securityAuditLog').add({
    action:     'alert_dismissed',
    alertId,
    actorId:    req.auth.uid,
    resolution: _san(resolution, 200),
    notes:      _san(notes, 500),
    createdAt:  FieldValue.serverTimestamp(),
  });

  _log('INFO', 'Fraud alert dismissed', { alertId, actorId: req.auth.uid, resolution });

  return { alertId, status: 'dismissed' };
});

/* ================================================================
   7. escalateFraudAlert
   Admin-only: escalate an alert, optionally creating an incident.
================================================================ */
exports.escalateFraudAlert = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { alertId, escalateTo, notes = '' } = req.data;

  if (!alertId)    throw new HttpsError('invalid-argument', 'alertId is required.');
  if (!escalateTo) throw new HttpsError('invalid-argument', 'escalateTo is required.');

  const firestore = db();
  const alertRef  = firestore.doc(`securityAlerts/${alertId}`);
  const alertSnap = await alertRef.get();

  if (!alertSnap.exists) throw new HttpsError('not-found', `Alert ${alertId} not found.`);

  const alertData = alertSnap.data();
  const now       = FieldValue.serverTimestamp();

  await alertRef.update({
    status:       'escalated',
    escalatedAt:  now,
    escalatedBy:  req.auth.uid,
    escalateTo:   _san(escalateTo, 128),
    notes:        _san(notes, 500),
  });

  /* ── Optionally create a securityIncident ─────────────────────── */
  let incidentId = null;
  if (alertData.severity === 'critical' || alertData.severity === 'high') {
    const incidentRef = firestore.collection('securityIncidents').doc();
    incidentId        = incidentRef.id;
    await incidentRef.set({
      incidentId,
      type:          alertData.type  || 'escalated_alert',
      severity:      alertData.severity,
      title:         `Escalated alert: ${alertData.type || alertId}`,
      description:   _san(notes, 500),
      status:        'open',
      createdAt:     now,
      createdBy:     req.auth.uid,
      sourceAlertId: alertId,
      affectedUsers: alertData.userId ? [alertData.userId] : [],
      timeline:      [{
        event:    'created_from_alert',
        alertId,
        at:       new Date().toISOString(),
        by:       req.auth.uid,
        notes:    _san(notes, 500),
      }],
      resolvedAt: null,
      resolvedBy: null,
    });
  }

  await firestore.collection('securityAuditLog').add({
    action:     'alert_escalated',
    alertId,
    incidentId,
    actorId:    req.auth.uid,
    escalateTo: _san(escalateTo, 128),
    notes:      _san(notes, 500),
    createdAt:  FieldValue.serverTimestamp(),
  });

  _log('INFO', 'Fraud alert escalated', { alertId, escalateTo, incidentId, actorId: req.auth.uid });

  return { alertId, status: 'escalated', incidentId };
});

/* ================================================================
   8. getFraudReport
   Admin-only: aggregate fraud analytics for a date range.
   Returns event counts, alert severity breakdown, top risk users,
   KES value at risk, and resolution rates.
================================================================ */
exports.getFraudReport = onCall(CF_OPTIONS, async (req) => {
  _requireAdmin(req.auth);

  const { startDate, endDate, sellerId } = req.data;

  if (!startDate || !endDate) {
    throw new HttpsError('invalid-argument', 'startDate and endDate are required.');
  }

  const start = new Date(startDate);
  const end   = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new HttpsError('invalid-argument', 'startDate and endDate must be valid ISO date strings.');
  }
  if (start >= end) {
    throw new HttpsError('invalid-argument', 'startDate must be before endDate.');
  }

  const firestore = db();

  /* ── Fetch events in range ────────────────────────────────────── */
  let eventsQuery = firestore
    .collection('securityEvents')
    .where('createdAt', '>=', start)
    .where('createdAt', '<=', end)
    .orderBy('createdAt', 'asc');

  if (sellerId) {
    /* Filter events tied to a seller via metadata.sellerId */
    eventsQuery = eventsQuery.where('metadata.sellerId', '==', sellerId);
  }

  const [eventsSnap, alertsSnap] = await Promise.all([
    eventsQuery.limit(5000).get(),
    firestore
      .collection('securityAlerts')
      .where('createdAt', '>=', start)
      .where('createdAt', '<=', end)
      .orderBy('createdAt', 'asc')
      .limit(5000)
      .get(),
  ]);

  /* ── Aggregate events by type ─────────────────────────────────── */
  const eventsByType = {};
  eventsSnap.docs.forEach(d => {
    const { eventType } = d.data();
    eventsByType[eventType] = (eventsByType[eventType] || 0) + 1;
  });

  /* ── Aggregate alerts by severity ─────────────────────────────── */
  const alertsBySeverity = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  const alertsByStatus   = { open: 0, dismissed: 0, escalated: 0, resolved: 0 };
  const userRiskMap      = {};
  let   kesAtRisk        = 0;

  alertsSnap.docs.forEach(d => {
    const data = d.data();
    if (data.severity && alertsBySeverity.hasOwnProperty(data.severity)) {
      alertsBySeverity[data.severity]++;
    }
    if (data.status && alertsByStatus.hasOwnProperty(data.status)) {
      alertsByStatus[data.status]++;
    }
    if (data.userId) {
      userRiskMap[data.userId] = (userRiskMap[data.userId] || 0) + 1;
    }
    /* Tally KES at risk from high/critical payment alerts */
    if ((data.severity === 'high' || data.severity === 'critical') &&
        typeof data.metadata?.amount === 'number') {
      kesAtRisk += data.metadata.amount;
    }
  });

  /* ── Top risk users (anonymized — show only count of risky users) ─ */
  const sortedUsers   = Object.entries(userRiskMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const topRiskUsers  = sortedUsers.map(([uid, alertCount], idx) => ({
    rank:        idx + 1,
    userId:      uid.slice(0, 6) + '****', /* Partial anonymisation */
    alertCount,
  }));

  /* ── Resolution rate ──────────────────────────────────────────── */
  const totalAlerts      = alertsSnap.size;
  const resolvedAlerts   = alertsByStatus.dismissed + alertsByStatus.resolved;
  const resolutionRate   = totalAlerts > 0
    ? Math.round((resolvedAlerts / totalAlerts) * 100)
    : 0;

  return {
    period:          { startDate, endDate },
    totalEvents:     eventsSnap.size,
    eventsByType,
    totalAlerts,
    alertsBySeverity,
    alertsByStatus,
    topRiskUsers,
    kesAtRisk:       Math.round(kesAtRisk),
    resolutionRate,  /* Percentage 0-100 */
  };
});

/* ================================================================
   9. scheduledFraudSweep
   Runs every hour at :05 (Africa/Nairobi).
   Scans the last 2 hours for:
     - Users with >= 3 login failures
     - Users with >= 5 payment failures
     - Open alerts older than 24h (stale)
   Updates securityRisk scores and creates/refreshes alerts.
   Results are logged to securityAuditLog.
================================================================ */
exports.scheduledFraudSweep = onSchedule(
  {
    schedule:  '5 * * * *',
    timeZone:  'Africa/Nairobi',
    region:    'us-central1',
  },
  async () => {
    const firestore  = db();
    const now        = Date.now();
    const twoHrAgo   = new Date(now - 2 * 60 * 60 * 1000);
    const twentyFourHrAgo = new Date(now - 24 * 60 * 60 * 1000);

    const sweepLog = {
      sweepAt:             new Date().toISOString(),
      loginFailures:       [],
      paymentFailures:     [],
      staleAlerts:         [],
      usersScoreUpdated:   [],
      alertsCreated:       0,
      errors:              [],
    };

    try {
      /* ── 1. Login failures in last 2h ─────────────────────────── */
      const loginFailSnap = await firestore
        .collection('securityEvents')
        .where('eventType', '==', 'login_fail')
        .where('createdAt', '>=', twoHrAgo)
        .get();

      const loginFailsByUser = {};
      loginFailSnap.docs.forEach(d => {
        const { userId } = d.data();
        if (userId) loginFailsByUser[userId] = (loginFailsByUser[userId] || 0) + 1;
      });

      /* ── 2. Payment failures in last 2h ───────────────────────── */
      const paymentFailSnap = await firestore
        .collection('securityEvents')
        .where('eventType', '==', 'payment_fail')
        .where('createdAt', '>=', twoHrAgo)
        .get();

      const paymentFailsByUser = {};
      paymentFailSnap.docs.forEach(d => {
        const { userId } = d.data();
        if (userId) paymentFailsByUser[userId] = (paymentFailsByUser[userId] || 0) + 1;
      });

      /* ── 3. Stale open alerts ─────────────────────────────────── */
      const staleAlertsSnap = await firestore
        .collection('securityAlerts')
        .where('status',    '==', 'open')
        .where('createdAt', '<=', twentyFourHrAgo)
        .limit(100)
        .get();

      /* ── Process login failures (>= 3) ─────────────────────────── */
      const loginFailBatch  = firestore.batch();
      let   loginAlertCount = 0;

      for (const [userId, count] of Object.entries(loginFailsByUser)) {
        if (count < 3) continue;
        sweepLog.loginFailures.push({ userId, count });

        /* Upsert risk score */
        const riskRef  = firestore.doc(`securityRisk/${userId}`);
        const riskSnap = await riskRef.get();
        const current  = riskSnap.data()?.riskScore ?? 0;
        const next     = _capScore(current + Math.min(count * 5, 25));
        loginFailBatch.set(riskRef, { riskScore: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        sweepLog.usersScoreUpdated.push({ userId, previous: current, next, reason: 'login_failures' });

        /* Create alert if score is elevated */
        if (next >= 50) {
          await _createAlert(firestore, {
            userId,
            type:     'repeated_login_fail',
            severity: count >= 10 ? 'high' : 'medium',
            metadata: { failCount: count, sweepWindow: '2h' },
          });
          loginAlertCount++;
        }
      }
      await loginFailBatch.commit();
      sweepLog.alertsCreated += loginAlertCount;

      /* ── Process payment failures (>= 5) ───────────────────────── */
      const paymentFailBatch  = firestore.batch();
      let   paymentAlertCount = 0;

      for (const [userId, count] of Object.entries(paymentFailsByUser)) {
        if (count < 5) continue;
        sweepLog.paymentFailures.push({ userId, count });

        const riskRef  = firestore.doc(`securityRisk/${userId}`);
        const riskSnap = await riskRef.get();
        const current  = riskSnap.data()?.riskScore ?? 0;
        const next     = _capScore(current + Math.min(count * 4, 30));
        paymentFailBatch.set(riskRef, { riskScore: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        sweepLog.usersScoreUpdated.push({ userId, previous: current, next, reason: 'payment_failures' });

        if (next >= 50) {
          await _createAlert(firestore, {
            userId,
            type:     'repeated_payment_fail',
            severity: count >= 15 ? 'high' : 'medium',
            metadata: { failCount: count, sweepWindow: '2h' },
          });
          paymentAlertCount++;
        }
      }
      await paymentFailBatch.commit();
      sweepLog.alertsCreated += paymentAlertCount;

      /* ── Tag stale alerts ───────────────────────────────────────── */
      const staleBatch = firestore.batch();
      staleAlertsSnap.docs.forEach(d => {
        sweepLog.staleAlerts.push(d.id);
        staleBatch.update(d.ref, {
          staleFlagged:  true,
          staleFlaggedAt: FieldValue.serverTimestamp(),
        });
      });
      await staleBatch.commit();

      _log('INFO', 'Scheduled fraud sweep complete', {
        loginFailUsers:   sweepLog.loginFailures.length,
        paymentFailUsers: sweepLog.paymentFailures.length,
        staleAlerts:      sweepLog.staleAlerts.length,
        alertsCreated:    sweepLog.alertsCreated,
      });

    } catch (err) {
      sweepLog.errors.push(err.message);
      _log('ERROR', 'Scheduled fraud sweep error', { err: err.message, stack: err.stack });
    }

    /* ── Persist sweep log ────────────────────────────────────────── */
    await firestore.collection('securityAuditLog').add({
      type:      'scheduled_fraud_sweep',
      ...sweepLog,
      createdAt: FieldValue.serverTimestamp(),
    });
  },
);

/* ── Module exports ─────────────────────────────────────────────── */
module.exports = {
  recordSecurityEvent:  exports.recordSecurityEvent,
  checkImpossibleTravel: exports.checkImpossibleTravel,
  checkPaymentVelocity: exports.checkPaymentVelocity,
  scoreFraudRisk:       exports.scoreFraudRisk,
  getFraudAlerts:       exports.getFraudAlerts,
  dismissFraudAlert:    exports.dismissFraudAlert,
  escalateFraudAlert:   exports.escalateFraudAlert,
  getFraudReport:       exports.getFraudReport,
  scheduledFraudSweep:  exports.scheduledFraudSweep,
};
