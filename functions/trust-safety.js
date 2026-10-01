'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

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

/* 2026-10-01: a refusal is a typed HttpsError (permission-denied), not a bare Error that reaches the browser as
   "internal" — the queue must be able to say "you are not an administrator" honestly. */
function _requireAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new HttpsError('permission-denied', 'admin required');
}
function _requireSuperAdmin(req) {
  if (!req.auth?.token?.superAdmin) throw new HttpsError('permission-denied', 'superAdmin required');
}

/* ═════════════════════════════════════════════════════════════════════════
   THE ONE REPORT AUTHORITY (community C2, 2026-10-01)

   Store: `reports` (rules: create false — only this file writes it). Readers: AdminOS › Fraud & Trust › Reports
   Queue and super-admin.html › Trust reports (both mount sokoni-trust-queues.js → tsGetReports / tsReviewReport) and
   the seller's own listings in merchant-v2 (tsGetReports scope:'mine'). Reports are PRIVATE: never public, the seller
   never sees who reported or what they wrote.

   The parallel client stores (`flags` from SokoniReport, `communityReports`, `contentFlags`) are no longer written by
   the product/seller report path; closing their rules is a separate rules slice.
   ═════════════════════════════════════════════════════════════════════════ */

/* Entity types a report may target. 'listing' is the historical name the product page used for a product. */
const REPORT_ENTITY_TYPES = ['product', 'user', 'business', 'message', 'review'];
const REPORT_ENTITY_ALIASES = { listing: 'product' };

/* THE reason catalogue. The product page's wizard renders THIS list (tsGetReportReasons) — there is no client copy.
   A product report whose reason code is not here is refused. Types with no catalogue keep the historical free-text
   reason (≤120 chars, severity inferred). */
const REPORT_DETAIL_MAX = 500;
const REPORT_DETAIL_MIN_WHEN_REQUIRED = 10;
const REPORT_REASONS = Object.freeze({
  product: Object.freeze([
    { code: 'counterfeit',    label: 'Counterfeit or fake product',        severity: 'high',     hint: 'A copy of a brand, or not the genuine item it claims to be.' },
    { code: 'prohibited',     label: 'Prohibited or illegal item',         severity: 'critical', hint: 'Weapons, drugs, wildlife products, stolen goods or anything else not allowed on SOKONI.' },
    { code: 'misleading',     label: 'Misleading description or price',    severity: 'medium',   hint: 'The photos, description or price do not match what is being sold.' },
    { code: 'scam',           label: 'Scam or fraud',                      severity: 'critical', hint: 'Asks for payment outside SOKONI, or is not a real offer.' },
    { code: 'offensive',      label: 'Offensive or inappropriate content', severity: 'medium',   hint: 'Hateful, sexual or abusive words or images.' },
    { code: 'wrong_category', label: 'Wrong category',                     severity: 'low',      hint: 'Listed in a category it does not belong to.' },
    { code: 'other',          label: 'Something else',                     severity: 'low',      hint: 'Tell us what is wrong in the next step.', detailRequired: true },
  ].map(Object.freeze)),
});

function _normEntityType(t) {
  const s = String(t || '');
  return REPORT_ENTITY_ALIASES[s] || s;
}
function _cleanText(s, max) {
  /* strip control characters (keep newlines/tabs), trim, cap */
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
/* Deterministic report id: ONE report per reporter per entity, enforced by create() (a second create fails
   ALREADY_EXISTS atomically — no read-then-write race). The id embeds the reporter uid, so it is NEVER returned to a
   seller (scope:'mine' returns an opaque hash instead). */
function _reportDocId(uid, entityType, entityId) {
  return `${uid}_${entityType}_${entityId}`;
}
function _opaqueRef(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

/* THE STATE MAPPING — the one place the stored report status meets the shared moderation state machine
   (pending → approved(=upheld) | rejected(=dismissed) | changes_requested | archived | removed).
   Stored values are kept as they were (actioned / dismissed / escalated): every existing report carries them and
   tsCalculateRiskScore / tsGetTrustDashboard query them. New stored values use the shared names directly. */
const REPORT_STATE = Object.freeze({
  pending: 'pending',
  escalated: 'pending',             /* still awaiting a decision — flagged for a senior reviewer */
  actioned: 'approved',             /* upheld */
  dismissed: 'rejected',
  changes_requested: 'changes_requested',
  archived: 'archived',
  removed: 'removed',
});
/* decision action (shared vocabulary + the historical names) → stored status */
const REPORT_ACTIONS = Object.freeze({
  approve: 'actioned', uphold: 'actioned',
  dismiss: 'dismissed', reject: 'dismissed',
  escalate: 'escalated',
  request_changes: 'changes_requested',
  archive: 'archived',
  remove: 'removed',
});
/* stored status a report may move FROM, per target status. Anything else is refused (failed-precondition). */
const REPORT_TRANSITIONS = Object.freeze({
  actioned:          ['pending', 'escalated', 'changes_requested'],
  dismissed:         ['pending', 'escalated', 'changes_requested'],
  escalated:         ['pending'],
  changes_requested: ['pending', 'escalated'],
  archived:          ['pending', 'escalated', 'actioned', 'dismissed', 'changes_requested'],
  removed:           ['pending', 'escalated', 'actioned', 'dismissed', 'changes_requested', 'archived'],
});
function _stateOf(status) {
  return REPORT_STATE[status || 'pending'] || null;   /* an unknown stored status is shown as unknown, never guessed */
}
function _iso(ts) {
  return ts && typeof ts.toMillis === 'function' ? new Date(ts.toMillis()).toISOString() : null;
}

/* ─────────────────────────────────────────────────────────────────────────
   0. tsGetReportReasons — the reason catalogue for a report type (no client copy exists)
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetReportReasons = onCall(OPT_REPORT, async (req) => {
  const entityType = _normEntityType((req.data || {}).entityType);
  if (!REPORT_ENTITY_TYPES.includes(entityType)) throw new HttpsError('invalid-argument', 'Unknown report type.');
  const list = REPORT_REASONS[entityType] || null;
  return {
    entityType,
    reasons: list ? list.map((r) => ({ code: r.code, label: r.label, hint: r.hint || '', detailRequired: r.detailRequired === true })) : [],
    freeText: !list,
    detailMax: REPORT_DETAIL_MAX,
    detailMinWhenRequired: REPORT_DETAIL_MIN_WHEN_REQUIRED,
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   1. tsReportContent — any authenticated user files a report
──────────────────────────────────────────────────────────────────────────── */
exports.tsReportContent = onCall(OPT_REPORT, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to report.');
  const d = req.data || {};
  const entityType = _normEntityType(d.entityType);
  const entityId = String(d.entityId || '').trim().slice(0, 128);
  if (!entityId || /[/]/.test(entityId) || entityId === '.' || entityId === '..' || !REPORT_ENTITY_TYPES.includes(entityType)) {
    throw new HttpsError('invalid-argument', 'A known report type and the item being reported are required.');
  }

  /* reason: a CODE from the server catalogue where one exists; otherwise the historical free text */
  const catalogue = REPORT_REASONS[entityType] || null;
  let reason, reasonCode = null, severity, detailRequired = false;
  if (catalogue) {
    const hit = catalogue.find((r) => r.code === String(d.reasonCode || d.reason || ''));
    if (!hit) throw new HttpsError('invalid-argument', 'Choose one of the listed reasons.');
    reason = hit.label; reasonCode = hit.code; severity = hit.severity; detailRequired = hit.detailRequired === true;
  } else {
    reason = _cleanText(d.reason, 120);
    if (!reason) throw new HttpsError('invalid-argument', 'A reason is required.');
    severity = _inferSeverity(reason);
  }
  const detail = _cleanText(d.detail, REPORT_DETAIL_MAX);
  if (detailRequired && detail.length < REPORT_DETAIL_MIN_WHEN_REQUIRED) {
    throw new HttpsError('invalid-argument', `Describe the problem (at least ${REPORT_DETAIL_MIN_WHEN_REQUIRED} characters).`);
  }
  const evidenceUrls = (Array.isArray(d.evidenceUrls) ? d.evidenceUrls : [])
    .filter((u) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 5).map((u) => u.slice(0, 500));

  const db = getFirestore();

  /* Historical reports (auto ids, before 2026-10-01): one PENDING report per reporter per entity. */
  const dup = await db.collection('reports')
    .where('entityId', '==', entityId)
    .where('reportedBy', '==', uid)
    .where('status', '==', 'pending')
    .limit(1).get();
  if (!dup.empty) throw new HttpsError('already-exists', 'You have already reported this. Our team is reviewing it.');

  /* PRODUCT CONTEXT, captured by the SERVER at report time: the product, its seller / shop and its state then.
     The seller identity is the product document's (never anything the reporter sent). */
  let context = null;
  if (entityType === 'product') {
    const ps = await db.collection('products').doc(entityId).get();
    if (!ps.exists) throw new HttpsError('not-found', 'That product no longer exists.');
    const p = ps.data() || {};
    context = {
      productName: String(p.name || '').slice(0, 120),
      sellerUid: p.sellerUid || p.sellerId || null,
      shopId: p.shopId || null,
      price: typeof p.price === 'number' ? p.price : null,
      status: p.status || null,
      isVisible: p.isVisible !== false,
    };
    if (context.sellerUid && context.sellerUid === uid) throw new HttpsError('failed-precondition', 'You cannot report your own product.');
  }

  const ref = db.collection('reports').doc(_reportDocId(uid, entityType, entityId));
  try {
    await ref.create({
      entityId, entityType, reason, reasonCode,
      detail,
      evidenceUrls,
      context,
      reportedBy: uid,   /* administrators only — never returned to a seller */
      status: 'pending',
      severity,
      createdAt: FieldValue.serverTimestamp(),
      reviewedBy: null,
      resolution: null,
      reviewedAt: null,
    });
  } catch (e) {
    if (e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS/i.test(String(e.message)))) {
      throw new HttpsError('already-exists', 'You have already reported this. Our team is reviewing it.');
    }
    throw e;
  }

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

  return { ok: true, reportId: ref.id, severity, status: 'pending', moderationState: 'pending' };
});

/* ─────────────────────────────────────────────────────────────────────────
   2. tsGetReports — admin: list reports with status filter
                     seller: scope:'mine' — reports on THEIR OWN products only
──────────────────────────────────────────────────────────────────────────── */
exports.tsGetReports = onCall(OPT, async (req) => {
  const data = req.data || {};
  if (data.scope === 'mine') return _myListingReports(req);
  _requireAdmin(req);
  const { status, state, entityType, severity, limit: lim } = data;

  const db = getFirestore();
  let q = db.collection('reports');
  if (state) {
    /* a filter in the SHARED vocabulary → the stored statuses it covers (REPORT_STATE is the one mapping) */
    const stored = Object.keys(REPORT_STATE).filter((k) => REPORT_STATE[k] === state);
    if (!stored.length) throw new HttpsError('invalid-argument', 'Unknown state.');
    q = stored.length === 1 ? q.where('status', '==', stored[0]) : q.where('status', 'in', stored);
  } else if (status) {
    q = q.where('status', '==', String(status));
  }
  q = q.limit(Math.min(Number(lim) || 100, 200));

  const snap = await q.get();
  let docs = snap.docs.map(d => {
    const r = d.data() || {};
    return { id: d.id, ...r, moderationState: _stateOf(r.status), createdAtIso: _iso(r.createdAt), reviewedAtIso: _iso(r.reviewedAt) };
  });

  // In-memory secondary filters — avoids composite indexes
  if (entityType) docs = docs.filter(d => d.entityType === _normEntityType(entityType));
  if (severity)   docs = docs.filter(d => d.severity === severity);
  docs.sort((a, b) => (b.createdAt?.seconds || b.createdAt?._seconds || 0) - (a.createdAt?.seconds || a.createdAt?._seconds || 0));

  return { reports: docs };
});

/* A SELLER reads reports about THEIR OWN products, filtered by the server on the server-captured context.sellerUid.
   Withheld: who reported (reportedBy), the document id (it embeds the reporter uid), the reporter's free text and
   evidence. Reports an administrator REMOVED (abusive / bad-faith reports) are not shown. */
async function _myListingReports(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await getFirestore().collection('reports').where('context.sellerUid', '==', uid).limit(100).get();
  const reports = snap.docs.map((d) => {
    const r = d.data() || {}; const c = r.context || {};
    const status = r.status || 'pending';
    const moderationState = _stateOf(status);
    return {
      ref: _opaqueRef(d.id),
      entityType: r.entityType || null, entityId: r.entityId || null,
      productName: c.productName || null, reasonCode: r.reasonCode || null, reason: r.reason || null,
      severity: r.severity || null, status, moderationState,
      productHidden: r.productHidden === true,
      /* the administrator's outcome note is shown once a report is decided — it tells the seller why */
      outcome: moderationState === 'pending' ? null : (String(r.resolution || '').slice(0, 500) || null),
      createdAt: _iso(r.createdAt),
      decidedAt: _iso(r.reviewedAt),
    };
  }).filter((x) => x.moderationState !== 'removed')
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return { reports, scope: 'mine' };
}

/* ─────────────────────────────────────────────────────────────────────────
   3. tsReviewReport — admin: decide a report on the shared state machine
──────────────────────────────────────────────────────────────────────────── */
exports.tsReviewReport = onCall(OPT, async (req) => {
  _requireAdmin(req);
  const data = req.data || {};
  const reportId = String(data.reportId || '');
  const action = String(data.action || '');
  if (!reportId || /[/]/.test(reportId) || !action) throw new HttpsError('invalid-argument', 'reportId and action are required.');
  const newStatus = REPORT_ACTIONS[action];
  if (!newStatus) throw new HttpsError('invalid-argument', 'action must be one of ' + Object.keys(REPORT_ACTIONS).join('|'));
  const resolution = _cleanText(data.resolution, 500);

  const db = getFirestore();
  const ref = db.collection('reports').doc(reportId);
  const auditRef = db.collection('trustSafetyAudit').doc();
  const wantHide = action !== 'escalate' && REPORT_STATE[newStatus] === 'approved' && data.hideProduct === true;

  /* ONE transaction: the transition is checked against the report as it is NOW (two admins deciding at once cannot
     both win), and the product take-down and the audit entry land with it or not at all. All reads before writes. */
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Report not found.');
    const report = snap.data() || {};
    const from = report.status || 'pending';
    if (!(REPORT_TRANSITIONS[newStatus] || []).includes(from)) {
      throw new HttpsError('failed-precondition', `This report is already ${REPORT_STATE[from] || from}; it cannot be moved to ${REPORT_STATE[newStatus]}.`);
    }
    let pref = null, psnap = null;
    if (wantHide && report.entityType === 'product') {
      pref = db.collection('products').doc(String(report.entityId));
      psnap = await tx.get(pref);
    }
    /* A PRODUCT report upheld with hideProduct takes the product off sale and out of discovery: isVisible:false
       (checkout refuses it) plus a moderationHold that records why. Only this admin path writes moderationHold. */
    const productHidden = !!(psnap && psnap.exists);
    tx.update(ref, Object.assign({
      status: newStatus,
      reviewedBy: req.auth.uid,
      resolution,
      reviewedAt: FieldValue.serverTimestamp(),
    }, productHidden ? { productHidden: true } : {}));
    if (productHidden) {
      tx.set(pref, { isVisible: false, moderationHold: { reportId, reason: report.reason || null, by: req.auth.uid, at: FieldValue.serverTimestamp() },
        updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    tx.set(auditRef, {
      action: 'report_reviewed',
      decision: action,
      reportId,
      entityId: report.entityId || null,
      entityType: report.entityType || null,
      from, fromState: REPORT_STATE[from] || null,
      result: newStatus, resultState: REPORT_STATE[newStatus],
      productHidden,
      resolution,
      performedBy: req.auth.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { report, productHidden };
  });

  // Ban the reported entity (user) if requested — only superAdmin can auto-ban; only on an upheld USER report
  if (data.banUser && req.auth?.token?.superAdmin && out.report.entityType === 'user' && newStatus === 'actioned') {
    await db.collection('users').doc(String(out.report.entityId)).update({
      status: 'banned',
      bannedAt: FieldValue.serverTimestamp(),
      bannedBy: req.auth.uid,
      banReason: resolution || `Report actioned: ${out.report.reason}`,
    });
  }

  return { success: true, status: newStatus, moderationState: REPORT_STATE[newStatus], productHidden: out.productHidden };
});

/* exported for tests and for the one documented mapping (CHANGELOG 2026-10-01 "community C2") */
exports._reportModel = { REPORT_ENTITY_TYPES, REPORT_REASONS, REPORT_STATE, REPORT_ACTIONS, REPORT_TRANSITIONS,
  REPORT_DETAIL_MAX, REPORT_DETAIL_MIN_WHEN_REQUIRED };

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
