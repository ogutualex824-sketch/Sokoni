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
  await ref.update({
    status: newStatus,
    reviewedBy: req.auth.uid,
    resolution: (resolution || '').slice(0, 500),
    reviewedAt: FieldValue.serverTimestamp(),
  });

  // Ban the reported entity (user) if requested — only superAdmin can auto-ban
  if (banUser && req.auth?.token?.superAdmin && report.entityType === 'user') {
    await db.collection('users').doc(report.entityId).update({
      status: 'banned',
      bannedAt: FieldValue.serverTimestamp(),
      bannedBy: req.auth.uid,
      banReason: resolution || `Report actioned: ${report.reason}`,
    });
  }

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
exports.tsBanUser = onCall(OPT, async (req) => {
  _requireSuperAdmin(req);
  const { uid: targetUid, action, reason, durationDays } = req.data;
  if (!targetUid || !action || !reason) throw new Error('uid, action, reason required');
  const validActions = ['ban', 'suspend', 'restore'];
  if (!validActions.includes(action)) throw new Error('action must be ban|suspend|restore');

  const db = getFirestore();
  const userRef = db.collection('users').doc(targetUid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');

  const statusMap = { ban: 'banned', suspend: 'suspended', restore: 'active' };
  const update = {
    status: statusMap[action],
    statusUpdatedAt: FieldValue.serverTimestamp(),
    statusUpdatedBy: req.auth.uid,
  };

  if (action === 'ban') {
    update.bannedAt = FieldValue.serverTimestamp();
    update.bannedBy = req.auth.uid;
    update.banReason = reason;
  }
  if (action === 'suspend') {
    update.suspendReason = reason;
    update.suspendedUntil = durationDays
      ? new Date(Date.now() + durationDays * 86400000)
      : null;
  }
  if (action === 'restore') {
    update.bannedAt = null;
    update.banReason = null;
    update.suspendedUntil = null;
  }

  await userRef.update(update);

  await db.collection('trustSafetyAudit').add({
    action: `user_${action}`,
    entityId: targetUid,
    entityType: 'user',
    reason,
    performedBy: req.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { success: true, newStatus: statusMap[action] };
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
