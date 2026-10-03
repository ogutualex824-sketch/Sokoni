'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/* ── Severity inference ─────────────────────────────────────────────────── */
const SEVERITY_KEYWORDS = {
  critical: ['scam','fraud','illegal','abuse','child','threat','extort','kidnap','weapon','drug'],
  high:     ['fake','misleading','stolen','violence','hate','impersonation','phishing'],
  medium:   ['spam','inappropriate','offensive','copyright','counterfeit'],
};
function _inferSeverity(reason) {
  const r = (reason || '').toLowerCase();
  for (const [level, words] of Object.entries(SEVERITY_KEYWORDS)) {
    if (words.some(w => r.includes(w))) return level;
  }
  return 'low';
}

const OPT        = { region: 'us-central1', enforceAppCheck: true, maxInstances: 10 };
const OPT_REPORT = { region: 'us-central1', enforceAppCheck: true, maxInstances: 30 };

function _requireAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new Error('admin required');
}
function _requireSuperAdmin(req) {
  if (!req.auth?.token?.superAdmin) throw new Error('superAdmin required');
}

/* ─────────────────────────────────────────────────────────────────────────
   1. tsReportContent — any authenticated user files a report
──────────────────────────────────────────────────────────────────────────── */
exports.tsReportContent = onCall(OPT_REPORT, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new Error('auth/unauthenticated');
  const { entityId, entityType, reason, detail } = req.data;
  if (!entityId || !entityType || !reason) throw new Error('entityId, entityType, reason required');

  const db = getFirestore();

  // Deduplicate: one pending report per user per entity
  const dup = await db.collection('reports')
    .where('entityId', '==', entityId)
    .where('reportedBy', '==', uid)
    .where('status', '==', 'pending')
    .limit(1).get();
  if (!dup.empty) throw new Error('You have already reported this content');

  const severity = _inferSeverity(reason);
  const ref = await db.collection('reports').add({
    entityId, entityType, reason,
    detail: (detail || '').slice(0, 500),
    reportedBy: uid,
    status: 'pending',
    severity,
    createdAt: FieldValue.serverTimestamp(),
    reviewedBy: null,
    resolution: null,
    reviewedAt: null,
  });

  // Push admin notification for critical reports
  if (severity === 'critical') {
    await db.collection('notifications').add({
      type: 'trust_safety_critical',
      title: 'Critical Report Filed',
      body: `Critical ${entityType} report: ${entityId}`,
      targetRole: 'admin',
      priority: 1,
      entityId: ref.id,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  return { reportId: ref.id, severity };
});

/* ─────────────────────────────────────────────────────────────────────────
   2. tsGetReports — admin: list reports with status filter
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetReports = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const { status, entityType, severity, limit: lim } = req.data;

  const db = getFirestore();
  let q = db.collection('reports');
  if (status) q = q.where('status', '==', status);
  q = q.limit(Math.min(lim || 100, 200));

  const snap = await q.get();
  let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // In-memory secondary filters — avoids composite indexes
  if (entityType) docs = docs.filter(d => d.entityType === entityType);
  if (severity)   docs = docs.filter(d => d.severity === severity);
  docs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  return { reports: docs };
});

/* ─────────────────────────────────────────────────────────────────────────
   3. tsReviewReport — admin: approve | dismiss | escalate
──────────────────────────────────────────────────────────────────────────── */
exports.tsReviewReport = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const { reportId, action, resolution, banUser } = req.data;
  if (!reportId || !action) throw new Error('reportId, action required');
  const validActions = { approve: 'actioned', dismiss: 'dismissed', escalate: 'escalated' };
  if (!validActions[action]) throw new Error('action must be approve|dismiss|escalate');

  const db = getFirestore();
  const ref = db.collection('reports').doc(reportId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Report not found');
  const report = snap.data();

  const newStatus = validActions[action];

  /* Ban the reported entity (user) if requested — only superAdmin can auto-ban. LIVE wrote status:'banned' directly
     (no Auth lockout, no history, no audit — a second ban semantic). It now goes through the ONE account-lock contract
     (kind 'ban': Auth disabled + sessions revoked + history + adminAudit + auditLog + trustSafetyAudit), and BEFORE the
     report is marked reviewed, so a refused ban (e.g. a super admin target) leaves the report open. */
  if (banUser && req.auth?.token?.superAdmin && report.entityType === 'user') {
    const { HttpsError } = require('firebase-functions/v2/https');
    try {
      await require('./shared/account-suspension').setSuspension({
        db, auth: require('firebase-admin/auth').getAuth(), serverTs: () => FieldValue.serverTimestamp(),
        actor: { uid: req.auth.uid, superAdmin: true }, uid: report.entityId, suspend: true, kind: 'ban',
        reason: String(resolution || '').trim() || `Report actioned: ${report.reason || reportId}`, source: 'trust_safety_report',
      });
    } catch (e) {
      if (e && e.code && typeof e.code === 'string') throw new HttpsError(e.code, e.message);
      throw e;
    }
  }

  await ref.update({
    status: newStatus,
    reviewedBy: req.auth.uid,
    resolution: (resolution || '').slice(0, 500),
    reviewedAt: FieldValue.serverTimestamp(),
  });

  await db.collection('trustSafetyAudit').add({
    action: 'report_reviewed',
    reportId,
    entityId: report.entityId,
    entityType: report.entityType,
    result: newStatus,
    resolution: resolution || '',
    performedBy: req.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { success: true, status: newStatus };
});

/* ─────────────────────────────────────────────────────────────────────────
   4. tsBanUser — superAdmin: ban | suspend | restore user
──────────────────────────────────────────────────────────────────────────── */
/* RETIRED as a separate suspension path (owner 2026-10-04): it wrote status only — the account could still sign in.
   ban / suspend → the canonical contract (shared/account-suspension.js: Auth disabled + sessions revoked + status +
   history + audit); restore → reinstate through the same contract. 'ban' and 'suspend' are one state: suspended.
   durationDays was never enforced (no job read suspendedUntil) and is refused rather than silently ignored. */
exports.tsBanUser = onCall(OPT, async (req) => {
  const { HttpsError } = require('firebase-functions/v2/https');
  const { uid, action, reason, durationDays } = req.data || {};
  if (!['ban', 'suspend', 'restore', 'unban'].includes(action)) throw new HttpsError('invalid-argument', 'action must be ban|suspend|restore|unban');
  /* live contract kept: a reason is required for every action, incl. restore */
  if (!uid || !reason || !String(reason).trim()) throw new HttpsError('invalid-argument', 'uid, action, reason required');
  /* The suspension length is SERVER-FIXED (shared/account-suspension.js SUSPENSION_DAYS; owner 2026-10-04) —
     a client-chosen duration is refused. A ban is permanent. */
  if (durationDays != null && durationDays !== '') throw new HttpsError('invalid-argument', 'The suspension length is fixed by the platform (' + require('./shared/account-suspension').SUSPENSION_DAYS + ' days).');
  try {
    const r = await require('./shared/account-suspension').setSuspension({
      db: getFirestore(), auth: require('firebase-admin/auth').getAuth(), serverTs: () => FieldValue.serverTimestamp(),
      actor: req.auth ? { uid: req.auth.uid, superAdmin: req.auth.token && req.auth.token.superAdmin === true } : null,
      uid, suspend: action === 'ban' || action === 'suspend', kind: (action === 'ban' || action === 'unban') ? 'ban' : 'suspend',
      reason, source: 'trust_safety',
    });
    /* the trustSafetyAudit record (live trail) is written by the contract itself, once per real change */
    return Object.assign({ success: true, newStatus: r.resultingState ? r.resultingState.status : (r.suspended ? (r.kind === 'ban' ? 'banned' : 'suspended') : 'active') }, r);
  } catch (e) {
    if (e && e.code && typeof e.code === 'string') throw new HttpsError(e.code, e.message);
    throw e;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   5. tsCalculateRiskScore — admin: compute composite risk score for entity
──────────────────────────────────────────────────────────────────────────── */
exports.tsCalculateRiskScore = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const { entityId, entityType } = req.data;
  if (!entityId || !entityType) throw new Error('entityId, entityType required');

  const db = getFirestore();
  let score = 0;
  const factors = [];

  if (entityType === 'user') {
    const [userSnap, reportsSnap, disputesSnap] = await Promise.all([
      db.collection('users').doc(entityId).get(),
      db.collection('reports').where('entityId', '==', entityId).where('status', '==', 'actioned').limit(10).get(),
      db.collection('escrows').where('buyerId', '==', entityId).where('status', '==', 'disputed').limit(10).get(),
    ]);

    if (!userSnap.exists) throw new Error('User not found');
    const u = userSnap.data();

    // Account age
    const ageDays = (Date.now() - (u.createdAt?.toMillis?.() || Date.now())) / 86400000;
    if (ageDays < 7)  { score += 30; factors.push({ name: 'Account < 7 days',   impact: 30 }); }
    else if (ageDays < 30) { score += 15; factors.push({ name: 'Account < 30 days', impact: 15 }); }

    // Verification
    if (!u.verified && !u.emailVerified) { score += 20; factors.push({ name: 'Unverified account', impact: 20 }); }

    // Status
    if (u.status === 'banned' || u.status === 'suspended') {
      score += 50; factors.push({ name: 'Previously restricted', impact: 50 });
    }

    // Actioned reports
    if (reportsSnap.size > 0) {
      const ri = reportsSnap.size * 15;
      score += ri;
      factors.push({ name: `${reportsSnap.size} actioned reports`, impact: ri });
    }

    // Disputes filed
    if (disputesSnap.size > 0) {
      const di = disputesSnap.size * 10;
      score += di;
      factors.push({ name: `${disputesSnap.size} disputes filed`, impact: di });
    }
  }

  score = Math.min(score, 100);
  const riskLevel = score >= 70 ? 'critical' : score >= 40 ? 'high' : score >= 20 ? 'medium' : 'low';

  await db.collection('riskScores').doc(entityId).set({
    entityId, entityType, score, riskLevel, factors,
    calculatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { score, riskLevel, factors };
});

/* ─────────────────────────────────────────────────────────────────────────
   6. tsGetRiskScores — admin: list high-risk entities
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetRiskScores = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const { riskLevel, entityType, limit: lim } = req.data;

  const db = getFirestore();
  let q = db.collection('riskScores').orderBy('score', 'desc').limit(Math.min(lim || 50, 200));
  if (riskLevel) q = q.where('riskLevel', '==', riskLevel);

  const snap = await q.get();
  let scores = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (entityType) scores = scores.filter(s => s.entityType === entityType);

  return { scores };
});

/* ─────────────────────────────────────────────────────────────────────────
   7. tsGetBannedTerms — admin: list all banned terms
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetBannedTerms = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const snap = await db.collection('bannedTerms').limit(500).get();
  return { terms: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ─────────────────────────────────────────────────────────────────────────
   8. tsManageBannedTerm — admin: add | delete a banned term
──────────────────────────────────────────────────────────────────────────── */
exports.tsManageBannedTerm = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const { action, termId, term } = req.data;
  const db = getFirestore();

  if (action === 'add') {
    if (!term) throw new Error('term required');
    const clean = term.toLowerCase().trim().slice(0, 100);
    await db.collection('bannedTerms').add({
      term: clean,
      addedBy: req.auth.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { success: true };
  }
  if (action === 'delete') {
    if (!termId) throw new Error('termId required');
    await db.collection('bannedTerms').doc(termId).delete();
    return { success: true };
  }
  throw new Error('action must be add|delete');
});

/* ─────────────────────────────────────────────────────────────────────────
   9. tsGetTrustDashboard — admin: aggregate stats
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetTrustDashboard = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const db = getFirestore();

  const [pending, actioned, dismissed, critical, banned, highRisk] = await Promise.all([
    db.collection('reports').where('status', '==', 'pending').limit(500).get(),
    db.collection('reports').where('status', '==', 'actioned').limit(500).get(),
    db.collection('reports').where('status', '==', 'dismissed').limit(500).get(),
    db.collection('reports').where('severity', '==', 'critical').where('status', '==', 'pending').limit(100).get(),
    db.collection('users').where('status', '==', 'banned').limit(500).get(),
    db.collection('riskScores').where('riskLevel', '==', 'high').limit(200).get(),
  ]);

  // Entity type breakdown of pending reports (in-memory)
  const breakdown = {};
  pending.docs.forEach(d => {
    const t = d.data().entityType || 'unknown';
    breakdown[t] = (breakdown[t] || 0) + 1;
  });

  return {
    pending: pending.size,
    actioned: actioned.size,
    dismissed: dismissed.size,
    criticalPending: critical.size,
    totalBanned: banned.size,
    highRiskEntities: highRisk.size,
    entityBreakdown: breakdown,
  };
});
