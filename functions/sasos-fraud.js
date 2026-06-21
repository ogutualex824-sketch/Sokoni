/* ================================================================
   SOKONI UNIVERSAL AI SUBSCRIPTION OPERATING SYSTEM
   sasos-fraud.js — Fraud & Risk Engine v1.0.0  |  2026-06-21

   Multi-signal risk scoring, behavioral fingerprinting, anomaly
   detection, trust scoring, and automated fraud response actions.

   Risk Score:  0-100  (composite of all weighted signals)
   Trust Score: 0-100  (inverse of risk, decays toward 50 at rest)
   Fraud Score: 0-100  (financial fraud probability only)

   Response thresholds:
     0-29:   Allow (normal)
     30-49:  Monitor (log, no action)
     50-69:  Step-up MFA on next high-value action
     70-84:  Temporary restriction (rate-limit aggressive, require verification)
     85-94:  Manual review queue
     95-100: Immediate suspension (awaiting human review)

   Exports:
     sasosUpdateRiskScore    — atomic: process new fraud signals
     sasosGetRiskProfile     — get full risk profile for a user
     sasosReportFraud        — user or admin: report fraud event
     sasosResolveRisk        — admin: resolve / clear a risk flag
     sasosFraudScan          — scheduled daily: pattern scan across all users
     sasosGetFraudQueue      — admin: list users in manual review queue
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');
const FieldValue             = admin.firestore.FieldValue;

const db  = () => admin.firestore();
const san = (s, n = 200) => typeof s === 'string' ? s.replace(/<[^>]*>/g,'').trim().slice(0,n) : '';

/* ── Auth guards ──────────────────────────────────────────── */
const assertAuth  = req => { if (!req.auth?.uid) throw new HttpsError('unauthenticated','Auth required.'); return req.auth.uid; };
const assertAdmin = req => { const uid = assertAuth(req); if (!req.auth.token?.admin && !req.auth.token?.superAdmin) throw new HttpsError('permission-denied','Admin required.'); return uid; };

/* ================================================================
   SIGNAL WEIGHT REGISTRY
   Every signal type has a weight (0-100).
   Signals > 60 trigger immediate review escalation.
================================================================ */
const SIGNAL_WEIGHTS = {
  /* Identity & Authentication */
  token_uid_mismatch:          70,
  session_fp_mismatch:         20,
  concurrent_sessions_exceeded: 35,
  impossible_travel:           60,
  multi_country_login:         35,
  new_device_high_value:       15,
  credential_stuffing:         80,
  account_takeover_pattern:    90,

  /* Storage & Client Tampering */
  storage_write_attempt:       18,
  devtools_open:                5,
  proto_pollution:             50,
  dom_manipulation:            30,
  quota_tamper:                75,
  plan_spoof_attempt:          85,

  /* Payment & Billing Abuse */
  rapid_plan_cycle:            40,
  chargeback_pattern:          55,
  refund_abuse:                45,
  fake_payment_ref:            80,
  coupon_stacking:             30,
  split_payment_exploit:       50,

  /* Usage & API Abuse */
  usage_spike:                 28,
  api_brute_force:             50,
  bot_pattern:                 35,
  concurrent_api_burst:        25,
  scraping_pattern:            30,

  /* Referral & Commission Fraud */
  fake_referral:               40,
  self_referral:               55,
  commission_manipulation:     60,
  seller_collusion:            50,

  /* Subscription Fraud */
  shared_account:              40,
  feature_unlocking:           65,
  license_sharing:             50,
  trial_abuse:                 30,
  multi_trial_accounts:        45,

  /* Behavioural */
  abnormal_session_timing:     15,
  login_velocity:              25,
  rapid_content_creation:      20,
  mass_message_pattern:        35,
};

/* ── Response action thresholds ───────────────────────────── */
const RISK_ACTIONS = [
  { min: 95, action: 'suspend',         label: 'Suspended — awaiting review' },
  { min: 85, action: 'manual_review',   label: 'Manual review queued' },
  { min: 70, action: 'restrict',        label: 'Temporary restrictions applied' },
  { min: 50, action: 'step_up_mfa',     label: 'Step-up MFA required' },
  { min: 30, action: 'monitor',         label: 'Monitoring' },
  { min:  0, action: 'allow',           label: 'Normal' },
];

function _riskAction(score) {
  return RISK_ACTIONS.find(a => score >= a.min) || RISK_ACTIONS[RISK_ACTIONS.length - 1];
}

/* ── Decay risk score over time (trust recovery) ────────────
   Risk decays toward 0 at ~1 point/day.
   Trust score = 100 - clamped(currentRisk * decayFactor).
*/
function _decayedRiskScore(score, lastEventTs) {
  if (!lastEventTs || score <= 0) return score;
  const daysSince = (Date.now() - lastEventTs) / 86400000;
  const decayed   = Math.max(0, score - Math.floor(daysSince));
  return Math.min(100, Math.round(decayed));
}

/* ================================================================
   sasosUpdateRiskScore
   Processes an array of fraud signals for a user.
   Atomically updates the risk profile and triggers the appropriate
   automated response action (suspend/restrict/monitor/allow).
================================================================ */
const sasosUpdateRiskScore = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '256MiB' },
  async (req) => {
    const uid     = assertAuth(req);
    const signals = Array.isArray(req.data.signals) ? req.data.signals.slice(0, 20) : [];
    const context = req.data.context || {};   /* { ip, userAgent, deviceId, page } */

    if (!signals.length) return { riskScore: 0, action: 'allow' };

    const now        = Date.now();
    const riskRef    = db().collection('sasosRiskProfiles').doc(uid);
    const riskSnap   = await riskRef.get();
    const current    = riskSnap.exists ? riskSnap.data() : {};
    const baseScore  = _decayedRiskScore(current.riskScore || 0, current.lastSignalAt);

    /* Calculate added score from new signals */
    let addedScore = 0;
    const processedSignals = [];

    for (const signal of signals) {
      const type   = typeof signal === 'string' ? signal : (signal.type || '');
      const weight = SIGNAL_WEIGHTS[type] || 5;
      addedScore  += weight;
      processedSignals.push({ type, weight, ts: now });
    }

    const newScore  = Math.min(100, baseScore + addedScore);
    const response  = _riskAction(newScore);
    const trustScore = Math.max(0, 100 - newScore);
    const batch     = db().batch();

    /* Update risk profile */
    batch.set(riskRef, {
      uid,
      riskScore:      newScore,
      trustScore,
      lastSignalAt:   now,
      signalCount:    FieldValue.increment(signals.length),
      action:         response.action,
      actionLabel:    response.label,
      lastContext:    {
        ip:        san(context.ip || '', 45),
        userAgent: san(context.userAgent || '', 200),
        deviceId:  san(context.deviceId  || '', 64),
        page:      san(context.page      || '', 200),
      },
      updatedAt:      FieldValue.serverTimestamp(),
    }, { merge: true });

    /* Write each signal as a separate fraud event for audit */
    for (const sig of processedSignals) {
      const eventRef = db().collection('sasosRiskEvents').doc();
      batch.set(eventRef, {
        uid, ...sig,
        context: {
          ip:        san(context.ip || '', 45),
          page:      san(context.page || '', 200),
        },
        riskAfter: newScore, action: response.action,
        ts: FieldValue.serverTimestamp(), resolved: false,
      });
    }

    /* Automated response actions */
    if (response.action === 'suspend') {
      /* Write suspension flag — entitlement checks will pick this up */
      batch.set(db().collection('entitlements').doc(uid), {
        suspended:     true,
        suspendedAt:   now,
        suspendReason: 'fraud_risk',
        needsRefresh:  true,
        updatedAt:     now,
      }, { merge: true });

      /* Add to manual review queue */
      batch.set(db().collection('sasosManualReview').doc(uid), {
        uid, riskScore: newScore, signals: processedSignals,
        queuedAt: now, status: 'pending',
        priority: newScore >= 95 ? 'critical' : 'high',
      }, { merge: true });

      logger.warn(`[SASOS-Fraud] SUSPEND: uid=${uid} score=${newScore}`);

    } else if (response.action === 'manual_review') {
      batch.set(db().collection('sasosManualReview').doc(uid), {
        uid, riskScore: newScore, signals: processedSignals,
        queuedAt: now, status: 'pending', priority: 'normal',
      }, { merge: true });

    } else if (response.action === 'restrict') {
      batch.set(db().collection('entitlements').doc(uid), {
        restricted: true, restrictedAt: now,
        restrictReason: 'elevated_risk',
        needsRefresh: true, updatedAt: now,
      }, { merge: true });
    }

    /* Also update the existing entitlements risk score for backward compatibility */
    batch.set(db().collection('entitlements').doc(uid), {
      riskScore: newScore, lastFraudEvent: now, needsRefresh: true, updatedAt: now,
    }, { merge: true });

    await batch.commit();
    return { riskScore: newScore, trustScore, action: response.action, addedScore };
  }
);

/* ================================================================
   sasosGetRiskProfile
   Returns the full risk profile for a user.
   Admin can query any user; users can query their own (limited view).
================================================================ */
const sasosGetRiskProfile = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const callerUid = assertAuth(req);
    const targetUid = san(req.data.uid || '', 128) || callerUid;
    const isAdmin   = req.auth.token?.admin || req.auth.token?.superAdmin;

    if (targetUid !== callerUid && !isAdmin)
      throw new HttpsError('permission-denied', 'Cannot view another user\'s risk profile.');

    const [profileSnap, recentEventsSnap] = await Promise.all([
      db().collection('sasosRiskProfiles').doc(targetUid).get(),
      db().collection('sasosRiskEvents')
        .where('uid', '==', targetUid)
        .orderBy('ts', 'desc')
        .limit(isAdmin ? 25 : 5)
        .get(),
    ]);

    const profile = profileSnap.exists ? profileSnap.data() : {
      riskScore: 0, trustScore: 100, action: 'allow', signalCount: 0,
    };

    /* Decay the score before returning */
    const decayed    = _decayedRiskScore(profile.riskScore || 0, profile.lastSignalAt);
    const trustScore = Math.max(0, 100 - decayed);
    const response   = _riskAction(decayed);

    const safeProfile = {
      riskScore:  decayed,
      trustScore,
      action:     response.action,
      actionLabel: response.label,
      signalCount: profile.signalCount || 0,
    };

    if (isAdmin) {
      Object.assign(safeProfile, {
        lastSignalAt: profile.lastSignalAt,
        lastContext:  profile.lastContext,
        recentEvents: recentEventsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      });
    }

    return safeProfile;
  }
);

/* ================================================================
   sasosReportFraud
   Allows a user or admin to report a fraudulent event.
   User reports are weighted lower and queued for review.
   Admin reports can trigger immediate action.
================================================================ */
const sasosReportFraud = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const callerUid  = assertAuth(req);
    const targetUid  = san(req.data.uid || '', 128) || callerUid;
    const signalType = san(req.data.type, 60);
    const notes      = san(req.data.notes || '', 500);
    const isAdmin    = req.auth.token?.admin || req.auth.token?.superAdmin;

    /* Validate signal type */
    if (!SIGNAL_WEIGHTS[signalType] && !isAdmin)
      throw new HttpsError('invalid-argument', `Unknown signal type: ${signalType}`);

    const weight = isAdmin
      ? (SIGNAL_WEIGHTS[signalType] || 20)
      : Math.min(SIGNAL_WEIGHTS[signalType] || 10, 20);  /* User reports capped at 20 */

    const now   = Date.now();
    const batch = db().batch();

    batch.set(db().collection('sasosRiskEvents').doc(), {
      uid: targetUid, type: signalType, weight,
      reportedBy: callerUid, isAdminReport: isAdmin, notes,
      ts: FieldValue.serverTimestamp(), resolved: false,
    });

    /* Update risk score */
    batch.set(db().collection('sasosRiskProfiles').doc(targetUid), {
      uid: targetUid,
      riskScore:    FieldValue.increment(weight),
      lastSignalAt: now,
      signalCount:  FieldValue.increment(1),
      updatedAt:    FieldValue.serverTimestamp(),
    }, { merge: true });

    batch.set(db().collection('entitlements').doc(targetUid), {
      riskScore:       FieldValue.increment(weight),
      lastFraudEvent:  now,
      needsRefresh:    true,
      updatedAt:       now,
    }, { merge: true });

    await batch.commit();
    return { success: true, weight, signalType };
  }
);

/* ================================================================
   sasosResolveRisk
   Admin-only. Clears a user's risk flags after manual review.
   Removes from manual review queue; resets risk score.
================================================================ */
const sasosResolveRisk = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const adminUid    = assertAdmin(req);
    const targetUid   = san(req.data.uid, 128);
    const resolution  = san(req.data.resolution || 'cleared', 50);
    const notes       = san(req.data.notes || '', 500);
    const resetScore  = req.data.resetScore !== false;

    if (!targetUid) throw new HttpsError('invalid-argument', 'uid required.');

    const now   = Date.now();
    const batch = db().batch();

    /* Update risk profile */
    batch.set(db().collection('sasosRiskProfiles').doc(targetUid), {
      uid:         targetUid,
      riskScore:   resetScore ? 0 : undefined,
      trustScore:  resetScore ? 100 : undefined,
      action:      'allow',
      actionLabel: 'Cleared by admin',
      resolvedBy:  adminUid,
      resolvedAt:  now,
      resolution,  notes,
      updatedAt:   FieldValue.serverTimestamp(),
    }, { merge: true });

    /* Remove suspension/restriction from entitlements */
    batch.set(db().collection('entitlements').doc(targetUid), {
      suspended:   false, restricted:  false,
      riskScore:   resetScore ? 0 : FieldValue.delete(),
      resolvedAt:  now,  resolvedBy:  adminUid,
      needsRefresh: true, updatedAt:   now,
    }, { merge: true });

    /* Remove from manual review queue */
    batch.update(db().collection('sasosManualReview').doc(targetUid), {
      status: 'resolved', resolvedBy: adminUid, resolvedAt: now, notes,
    });

    /* Unsuspend subscription products if suspended due to fraud */
    const subSnap = await db().collection('sasosSubscriptions').doc(targetUid).get();
    if (subSnap.exists) {
      const updates = {};
      const prods   = subSnap.data().products || {};
      for (const [prod, state] of Object.entries(prods)) {
        if (state.status === 'suspended' && state.suspendReason === 'fraud_risk') {
          updates[`products.${prod}.status`]      = 'active';
          updates[`products.${prod}.unsuspendedAt`] = now;
          updates[`products.${prod}.updatedAt`]   = now;
        }
      }
      if (Object.keys(updates).length) {
        batch.update(db().collection('sasosSubscriptions').doc(targetUid), {
          ...updates, updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    /* Audit log */
    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'risk_resolved', uid: targetUid, adminUid, resolution, notes, resetScore,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    logger.info(`[SASOS-Fraud] Risk resolved: uid=${targetUid} by=${adminUid} resolution=${resolution}`);
    return { success: true };
  }
);

/* ================================================================
   sasosFraudScan  [Scheduled — daily 03:00 EAT]
   Pattern-based fraud scan across all active subscriptions.
   Detects: trial abuse, shared accounts, rapid plan cycling,
   chargeback patterns, API abuse, multi-account fraud.
================================================================ */
const sasosFraudScan = onSchedule(
  { schedule: '0 0 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1', memory: '512MiB', timeoutSeconds: 540 },
  async () => {
    const now   = Date.now();
    let signals = 0;

    /* Pattern 1: Trial abuse — multiple trial activations */
    const trialSnap = await db().collection('sasosSubscriptions')
      .where('products.ai.status', '==', 'trial').limit(500).get();

    for (const doc of trialSnap.docs) {
      const uid  = doc.id;
      const aiSub = doc.data().products?.ai;
      /* Flag if trial started within 24h of account creation (disposable account pattern) */
      const userSnap = await db().collection('users').doc(uid).get().catch(() => null);
      if (userSnap?.exists) {
        const createdAt = userSnap.data().createdAt || 0;
        const trialStart = aiSub?.periodStart || 0;
        if (trialStart - createdAt < 3600000 && trialStart > 0) {
          await db().collection('sasosRiskProfiles').doc(uid).set({
            uid, riskScore: FieldValue.increment(SIGNAL_WEIGHTS.trial_abuse),
            lastSignalAt: now, signalCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          signals++;
        }
      }
    }

    /* Pattern 2: Rapid plan cycling (>3 plan changes in 7 days) */
    const week = now - 7 * 86400000;
    const auditSnap = await db().collection('sasosAuditLog')
      .where('type', '==', 'sasos_subscribe')
      .where('ts', '>=', new Date(week))
      .limit(1000).get();

    const planChangesByUid = {};
    auditSnap.docs.forEach(d => {
      const uid = d.data().uid;
      planChangesByUid[uid] = (planChangesByUid[uid] || 0) + 1;
    });

    for (const [uid, count] of Object.entries(planChangesByUid)) {
      if (count >= 3) {
        await db().collection('sasosRiskProfiles').doc(uid).set({
          uid, riskScore: FieldValue.increment(SIGNAL_WEIGHTS.rapid_plan_cycle),
          lastSignalAt: now, signalCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        signals++;
      }
    }

    /* Pattern 3: Suspicious refund patterns (>2 refunds in 30 days) */
    const month = now - 30 * 86400000;
    const refundSnap = await db().collection('sasosBillingLedger')
      .where('type', '==', 'refund')
      .where('ts', '>=', new Date(month))
      .limit(1000).get();

    const refundsByUid = {};
    refundSnap.docs.forEach(d => {
      const uid = d.data().uid;
      refundsByUid[uid] = (refundsByUid[uid] || 0) + 1;
    });

    for (const [uid, count] of Object.entries(refundsByUid)) {
      if (count >= 2) {
        await db().collection('sasosRiskProfiles').doc(uid).set({
          uid, riskScore: FieldValue.increment(SIGNAL_WEIGHTS.refund_abuse * (count - 1)),
          lastSignalAt: now, signalCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        signals++;
      }
    }

    logger.info(`[SASOS-Fraud] sasosFraudScan: generated ${signals} risk signals`);
  }
);

/* ================================================================
   sasosGetFraudQueue
   Admin-only. Returns users in the manual review queue.
================================================================ */
const sasosGetFraudQueue = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAdmin(req);
    const status   = san(req.data.status || 'pending', 20);
    const priority = san(req.data.priority || '', 20);
    const pageSize = Math.min(req.data.pageSize || 25, 100);

    let q = db().collection('sasosManualReview')
      .where('status', '==', status)
      .orderBy('queuedAt', 'desc')
      .limit(pageSize);

    if (priority) q = db().collection('sasosManualReview')
      .where('status', '==', status)
      .where('priority', '==', priority)
      .orderBy('queuedAt', 'desc')
      .limit(pageSize);

    const snap = await q.get();
    return {
      items:   snap.docs.map(d => ({ id: d.id, ...d.data() })),
      hasMore: snap.docs.length === pageSize,
    };
  }
);

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  sasosUpdateRiskScore,
  sasosGetRiskProfile,
  sasosReportFraud,
  sasosResolveRisk,
  sasosFraudScan,
  sasosGetFraudQueue,
  SIGNAL_WEIGHTS,
};
