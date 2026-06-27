'use strict';
/**
 * SOKONI Automation & Decision Engine (ADE) v1.0
 * Powers platform-wide intelligent automation, rules-based decisions,
 * exception queue, audit trail, and scheduled maintenance.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp  = admin.firestore.Timestamp;

// ─── Collections ─────────────────────────────────────────────────────────────
const C = {
  rules:      'ade_rules',
  decisions:  'ade_decisions',
  exceptions: 'ade_exception_queue',
  audit:      'ade_audit_log',
  jobs:       'ade_jobs',
};

const VALID_EVENTS  = ['account_registration','seller_application','refund_request','withdrawal','dispute','payment_received','subscription_change','content_report'];
const VALID_ACTIONS = ['auto_approve','auto_reject','escalate','request_info','hold','notify_only'];

// ─── Auth Guards ──────────────────────────────────────────────────────────────
function _requireAdmin(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required');
  const t = auth.token;
  if (!t.isAdmin && !t.isSuperAdmin && !t.isSupport && !t.isFinance)
    throw new HttpsError('permission-denied', 'Admin access required');
}
function _isSA(auth) {
  return auth && (auth.token.isSuperAdmin || auth.token.role === 'superAdmin');
}
function _sanitize(v) {
  return typeof v === 'string' ? v.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;','&':'&amp;'}[c])) : v;
}

// ─── Rules Engine ─────────────────────────────────────────────────────────────
// All multi-field queries done with single filter + in-memory sort/filter
// to stay within the 200 composite index limit.
async function _loadRules(eventType) {
  const snap = await db.collection(C.rules)
    .where('event_type', '==', eventType)
    .get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => r.enabled !== false)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

function _getNestedValue(obj, path) {
  return String(path).split('.').reduce((acc, k) => (acc != null ? acc[k] : undefined), obj);
}

function _evalCondition(cond, data) {
  const val = _getNestedValue(data, cond.field);
  switch (cond.operator) {
    case 'eq':        return val === cond.value;
    case 'neq':       return val !== cond.value;
    case 'gt':        return typeof val === 'number' && val > cond.value;
    case 'gte':       return typeof val === 'number' && val >= cond.value;
    case 'lt':        return typeof val === 'number' && val < cond.value;
    case 'lte':       return typeof val === 'number' && val <= cond.value;
    case 'in':        return Array.isArray(cond.value) && cond.value.includes(val);
    case 'not_in':    return Array.isArray(cond.value) && !cond.value.includes(val);
    case 'contains':  return typeof val === 'string' && val.includes(cond.value);
    case 'exists':    return val !== undefined && val !== null;
    case 'not_exists':return val === undefined || val === null;
    case 'truthy':    return !!val;
    case 'falsy':     return !val;
    default:          return false;
  }
}

function _matchRule(rule, data) {
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return true;
  return rule.conditions.every(c => _evalCondition(c, data));
}

// ─── Evidence Gathering ───────────────────────────────────────────────────────
async function _gatherEvidence(eventType, entityId, data) {
  const evidence = [];
  const userId = data.userId || data.uid || data.buyerId || data.customerId;

  try {
    if (userId) {
      const userDoc = await db.collection('users').doc(userId).get();
      if (userDoc.exists) {
        const u = userDoc.data();
        const age = _daysSince(u.createdAt);
        const disp = u.disputeCount || 0;
        const viol = u.violationCount || 0;
        evidence.push({
          type: 'user_history',
          description: `Account age: ${age}d, Disputes: ${disp}, Violations: ${viol}, Verified: ${!!u.emailVerified}`,
          weight: viol > 2 ? -35 : viol > 0 ? -15 : disp > 3 ? -10 : age > 30 ? 20 : 10,
          data: { age, disputeCount: disp, violationCount: viol, verified: !!u.emailVerified },
        });
      }
    }

    if (eventType === 'dispute' || eventType === 'refund_request') {
      const orderId = data.orderId;
      if (orderId) {
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (orderDoc.exists) {
          const ord = orderDoc.data();
          const isDelivered = ord.deliveryStatus === 'delivered';
          evidence.push({
            type: 'order_status',
            description: `Order: ${ord.status}, Delivery: ${ord.deliveryStatus || 'unknown'}`,
            weight: isDelivered ? 30 : ord.deliveryStatus === 'failed' ? -25 : 0,
            data: { status: ord.status, deliveryStatus: ord.deliveryStatus, amount: ord.amount },
          });
        }
        const paySnap = await db.collection('payments').where('orderId', '==', orderId).limit(1).get();
        if (!paySnap.empty) {
          const pay = paySnap.docs[0].data();
          evidence.push({
            type: 'payment_record',
            description: `Payment: ${pay.status}, KES ${Math.round((pay.amount || 0) / 100)}, via ${pay.method || '?'}`,
            weight: pay.status === 'completed' ? 25 : pay.status === 'failed' ? -20 : 0,
            data: { paymentStatus: pay.status, amount: pay.amount, method: pay.method },
          });
        }
      }
    }

    if (eventType === 'seller_application') {
      const sellerDoc = await db.collection('sellers').doc(entityId).get();
      if (sellerDoc.exists) {
        const s = sellerDoc.data();
        const hasId   = !!s.idDocument;
        const hasCert = s.businessCertificate !== undefined;
        const hasAddr = !!(s.businessAddress && s.county);
        evidence.push({
          type: 'seller_documents',
          description: `ID doc: ${hasId ? '✓' : '✗'}, Business cert: ${hasCert ? '✓' : '✗'}, Address: ${hasAddr ? '✓' : '✗'}`,
          weight: (hasId && hasAddr) ? 40 : hasId ? 20 : -15,
          data: { hasId, hasCert, hasAddr, category: s.category },
        });
      }
    }

    if (eventType === 'withdrawal') {
      const amount  = data.amount || 0;
      const walletDoc = await db.collection('wallets').doc(entityId).get();
      if (walletDoc.exists) {
        const w = walletDoc.data();
        const sufficient = (w.balance || 0) >= amount;
        evidence.push({
          type: 'wallet_balance',
          description: `Balance: KES ${Math.round((w.balance || 0) / 100)}, Requested: KES ${Math.round(amount / 100)}`,
          weight: sufficient ? 30 : -50,
          data: { balance: w.balance, requested: amount, sufficient },
        });
      }
    }
  } catch (err) {
    console.warn('ADE evidence error:', err.message);
  }

  return evidence;
}

function _scoreEvidence(evidence) {
  if (!evidence.length) return 50;
  const total = evidence.reduce((s, e) => s + (e.weight || 0), 0);
  const scale = evidence.length * 40;
  return Math.max(0, Math.min(100, Math.round(50 + (total / scale) * 50)));
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function _autoApprove(entityType, entityId, data, reason) {
  const base = {
    status: 'active',
    approvedAt: FieldValue.serverTimestamp(),
    approvedBy: 'system',
    approvalReason: reason || 'Auto-approved by ADE rules engine',
  };
  const coll = entityType === 'account' ? 'users' : entityType + 's';
  const extra = entityType === 'seller'
    ? { paymentsEnabled: true, posEnabled: true, communicationsEnabled: true }
    : {};
  await db.collection(coll).doc(entityId).update({ ...base, ...extra }).catch(e => {
    console.warn(`autoApprove ${coll}/${entityId}:`, e.message);
  });
}

async function _autoReject(entityType, entityId, reason) {
  const coll = entityType === 'account' ? 'users' : entityType + 's';
  await db.collection(coll).doc(entityId).update({
    status: 'rejected',
    rejectedAt: FieldValue.serverTimestamp(),
    rejectedBy: 'system',
    rejectionReason: reason || 'Rejected by ADE rules engine',
  }).catch(e => console.warn(`autoReject ${coll}/${entityId}:`, e.message));
}

async function _holdEntity(entityType, entityId, reason, durationHours) {
  const coll = entityType === 'account' ? 'users' : entityType + 's';
  await db.collection(coll).doc(entityId).update({
    status: 'held',
    heldAt: FieldValue.serverTimestamp(),
    holdReason: reason || 'Held by ADE rules engine',
    holdUntil: Timestamp.fromDate(new Date(Date.now() + (durationHours || 24) * 3600000)),
  }).catch(e => console.warn(`holdEntity ${coll}/${entityId}:`, e.message));
}

async function _addToExceptionQueue(params) {
  const { eventType, entityId, entityType, entityData, priority, recommendation, confidence, evidence, policy, decisionId } = params;

  // Idempotency: only one open exception per entity+eventType
  const existing = await db.collection(C.exceptions)
    .where('entity_id', '==', entityId)
    .get();
  const dup = existing.docs.find(d => {
    const x = d.data();
    return x.event_type === eventType && x.status === 'open';
  });
  if (dup) return dup.id;

  const ref = await db.collection(C.exceptions).add({
    event_type: eventType,
    entity_id: entityId,
    entity_type: entityType,
    entity_data: entityData || {},
    priority: priority || 'medium',
    recommendation: recommendation || 'Manual review required',
    confidence: confidence || 50,
    evidence: evidence || [],
    applicable_policy: policy || '',
    status: 'open',
    assigned_to: null,
    decision_id: decisionId || null,
    created_at: FieldValue.serverTimestamp(),
    resolved_at: null,
    resolved_by: null,
    resolution: null,
  });
  return ref.id;
}

// ─── Audit & Decision Records ─────────────────────────────────────────────────
async function _log(params) {
  await db.collection(C.audit).add({
    action_type:  params.actionType,
    entity_id:    params.entityId   || null,
    entity_type:  params.entityType || null,
    event_type:   params.eventType  || null,
    rule_id:      params.ruleId     || null,
    rule_name:    params.ruleName   || null,
    automated:    params.automated  !== false,
    actor:        params.actor      || 'system',
    decision:     params.decision,
    confidence:   params.confidence || null,
    trigger:      params.trigger    || 'system',
    outcome:      params.outcome    || params.decision,
    metadata:     params.metadata   || {},
    timestamp:    FieldValue.serverTimestamp(),
  }).catch(e => console.error('ADE log error:', e.message));
}

async function _recordDecision(params) {
  const ref = await db.collection(C.decisions).add({
    event_type:   params.eventType,
    entity_id:    params.entityId,
    entity_type:  params.entityType,
    trigger:      params.trigger || 'system',
    rule_id:      params.ruleId   || null,
    rule_name:    params.ruleName || null,
    decision:     params.decision,
    confidence:   params.confidence || 0,
    evidence:     params.evidence   || [],
    action_taken: params.action     || params.decision,
    action_params:params.actionParams || {},
    timestamp:    FieldValue.serverTimestamp(),
    overridden:   false,
    override_by:  null,
    override_at:  null,
    override_decision: null,
    override_reason:   null,
  });
  return ref.id;
}

// ─── Core Engine ──────────────────────────────────────────────────────────────
async function _processEvent(eventType, entityType, entityId, eventData, trigger) {
  console.log(`ADE: ${eventType} → ${entityType}/${entityId} [${trigger}]`);

  const evidence      = await _gatherEvidence(eventType, entityId, eventData);
  const evidenceScore = _scoreEvidence(evidence);
  const rules         = await _loadRules(eventType);

  // Find first matching rule (highest priority first)
  let matchedRule = null;
  const evalData = { ...eventData, _evidence_score: evidenceScore };
  for (const rule of rules) {
    if (_matchRule(rule, evalData)) { matchedRule = rule; break; }
  }

  if (!matchedRule) {
    const decisionId = await _recordDecision({
      eventType, entityType, entityId, trigger, evidence,
      confidence: evidenceScore, decision: 'escalated',
      ruleName: 'No matching rule',
    });
    await _addToExceptionQueue({
      eventType, entityId, entityType, entityData,
      priority: 'medium',
      recommendation: 'No automation rule matched. Manual review required.',
      confidence: evidenceScore, evidence,
      policy: 'Default: escalate unmatched events',
      decisionId,
    });
    await _log({ actionType: 'escalated', eventType, entityId, entityType, decision: 'escalated', confidence: evidenceScore, trigger });
    return { decision: 'escalated', confidence: evidenceScore };
  }

  const confidence  = matchedRule.confidence_override ?? evidenceScore;
  const threshold   = matchedRule.confidence_threshold ?? 70;
  const autoExecute = confidence >= threshold;
  const decision    = autoExecute ? matchedRule.action : 'escalated';

  const decisionId = await _recordDecision({
    eventType, entityType, entityId, trigger, evidence,
    confidence, decision,
    ruleId: matchedRule.id, ruleName: matchedRule.name,
    action: matchedRule.action, actionParams: matchedRule.action_params || {},
  });

  if (autoExecute) {
    try {
      const ap = matchedRule.action_params || {};
      switch (matchedRule.action) {
        case 'auto_approve': await _autoApprove(entityType, entityId, eventData, ap.message); break;
        case 'auto_reject':  await _autoReject(entityType, entityId, ap.message); break;
        case 'hold':         await _holdEntity(entityType, entityId, ap.message, ap.hours); break;
        case 'escalate':
          await _addToExceptionQueue({
            eventType, entityId, entityType, entityData,
            priority: ap.priority || 'high',
            recommendation: ap.recommendation || 'Rule requires human review',
            confidence, evidence, policy: matchedRule.description || '',
            decisionId,
          });
          break;
        case 'request_info': break; // notification handled by notification engine
        case 'notify_only':  break;
      }
      await _log({
        actionType: matchedRule.action, eventType, entityId, entityType,
        decision: matchedRule.action, confidence, trigger,
        ruleId: matchedRule.id, ruleName: matchedRule.name,
        outcome: 'executed', metadata: { autoExecute: true },
      });
      return { decision: matchedRule.action, ruleId: matchedRule.id, confidence, autoExecute: true };
    } catch (err) {
      console.error('ADE action failed, queuing retry:', err.message);
      await db.collection(C.jobs).add({
        job_type: 'execute_action',
        payload: { eventType, entityType, entityId, eventData, ruleId: matchedRule.id },
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        next_retry_at: Timestamp.fromDate(new Date(Date.now() + 60000)),
        error: err.message,
        created_at: FieldValue.serverTimestamp(),
        completed_at: null,
      });
      return { decision: 'failed_queued', ruleId: matchedRule.id, confidence };
    }
  }

  // Confidence below threshold → escalate with recommendation
  await _addToExceptionQueue({
    eventType, entityId, entityType, entityData,
    priority: confidence < 40 ? 'high' : 'medium',
    recommendation: `Rule "${matchedRule.name}" matched (confidence ${confidence}% < threshold ${threshold}%). Suggested action: ${matchedRule.action}.`,
    confidence, evidence, policy: matchedRule.description || '', decisionId,
  });
  await _log({
    actionType: 'escalated', eventType, entityId, entityType,
    decision: 'escalated', confidence, trigger,
    ruleId: matchedRule.id, ruleName: matchedRule.name,
    outcome: 'confidence_below_threshold',
  });
  return { decision: 'escalated', ruleId: matchedRule.id, confidence, autoExecute: false };
}

function _daysSince(ts) {
  if (!ts) return 0;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// ─── Firestore Triggers ───────────────────────────────────────────────────────

exports.adeOnAccountCreated = onDocumentCreated('users/{uid}', async event => {
  const data = event.data.data();
  // Skip: system-created internal accounts
  if (data.internal === true) return;
  await _processEvent('account_registration', 'account', event.params.uid, data, 'users_onCreate')
    .catch(e => console.error('adeOnAccountCreated:', e.message));
});

exports.adeOnPaymentCompleted = onDocumentWritten('payments/{paymentId}', async event => {
  if (!event.data.after.exists) return;
  const after  = event.data.after.data();
  const before = event.data.before.exists ? event.data.before.data() : {};
  if (before.status === 'completed' || after.status !== 'completed') return;
  await _processEvent('payment_received', 'payment', event.params.paymentId, after, 'payments_onWrite')
    .catch(e => console.error('adeOnPaymentCompleted:', e.message));
});

exports.adeOnDisputeCreated = onDocumentCreated('disputes/{disputeId}', async event => {
  const data = event.data.data();
  await _processEvent('dispute', 'dispute', event.params.disputeId, data, 'disputes_onCreate')
    .catch(e => console.error('adeOnDisputeCreated:', e.message));
});

exports.adeOnSellerApplied = onDocumentWritten('sellers/{sellerId}', async event => {
  if (!event.data.after.exists) return;
  const after  = event.data.after.data();
  const before = event.data.before.exists ? event.data.before.data() : {};
  if (before.status === after.status || after.status !== 'pending') return;
  await _processEvent('seller_application', 'seller', event.params.sellerId, after, 'sellers_onWrite')
    .catch(e => console.error('adeOnSellerApplied:', e.message));
});

exports.adeOnSubscriptionChanged = onDocumentWritten('subscriptions/{subId}', async event => {
  if (!event.data.after.exists) return;
  const after  = event.data.after.data();
  const before = event.data.before.exists ? event.data.before.data() : {};
  if (before.status === after.status) return;
  await _processEvent('subscription_change', 'subscription', event.params.subId,
    { ...after, previousStatus: before.status }, 'subscriptions_onWrite')
    .catch(e => console.error('adeOnSubscriptionChanged:', e.message));
});

// ─── Callable — Manually trigger engine ──────────────────────────────────────
exports.adeProcessEvent = onCall({ enforceAppCheck: true }, async request => {
  _requireAdmin(request.auth);
  const { eventType, entityType, entityId, eventData } = request.data;
  if (!eventType || !entityType || !entityId)
    throw new HttpsError('invalid-argument', 'eventType, entityType, entityId required');
  if (!VALID_EVENTS.includes(eventType))
    throw new HttpsError('invalid-argument', 'Invalid eventType');
  return _processEvent(eventType, entityType, entityId, eventData || {}, 'manual');
});

// ─── Callable — Exception Queue ───────────────────────────────────────────────
exports.adeGetExceptionQueue = onCall({ enforceAppCheck: true }, async request => {
  _requireAdmin(request.auth);
  const { status = 'open', priority, eventType, limit: lim = 50 } = request.data || {};
  const snap = await db.collection(C.exceptions).where('status', '==', status).get();
  let items  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (priority)  items = items.filter(i => i.priority   === priority);
  if (eventType) items = items.filter(i => i.event_type === eventType);
  items.sort((a, b) => {
    const ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
    const pd = (ORDER[a.priority] ?? 2) - (ORDER[b.priority] ?? 2);
    if (pd !== 0) return pd;
    return (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0);
  });
  return { items: items.slice(0, Math.min(lim, 100)), total: items.length };
});

// ─── Callable — Resolve Exception ─────────────────────────────────────────────
exports.adeResolveException = onCall({ enforceAppCheck: true }, async request => {
  _requireAdmin(request.auth);
  const { exceptionId, decision, reason, applyAction } = request.data;
  if (!exceptionId || !decision)
    throw new HttpsError('invalid-argument', 'exceptionId and decision required');

  const ref  = db.collection(C.exceptions).doc(exceptionId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Exception not found');
  const exc = snap.data();

  await ref.update({
    status: 'resolved',
    resolved_at: FieldValue.serverTimestamp(),
    resolved_by: request.auth.uid,
    resolution: decision,
    resolution_reason: _sanitize(reason || ''),
  });

  if (applyAction && exc.entity_id && exc.entity_type) {
    if (decision === 'approve') await _autoApprove(exc.entity_type, exc.entity_id, exc.entity_data, reason);
    if (decision === 'reject')  await _autoReject(exc.entity_type, exc.entity_id, reason);
    if (decision === 'hold')    await _holdEntity(exc.entity_type, exc.entity_id, reason, 24);
  }

  if (exc.decision_id) {
    await db.collection(C.decisions).doc(exc.decision_id).update({
      overridden: true,
      override_by: request.auth.uid,
      override_at: FieldValue.serverTimestamp(),
      override_decision: decision,
      override_reason: _sanitize(reason || ''),
    }).catch(() => {});
  }

  await _log({
    actionType: 'exception_resolved', eventType: exc.event_type,
    entityId: exc.entity_id, entityType: exc.entity_type,
    decision, automated: false, actor: request.auth.uid,
    trigger: 'admin_manual', outcome: decision,
    metadata: { exceptionId, reason: reason || '', applyAction: !!applyAction },
  });
  return { success: true };
});

// ─── Callable — Rules CRUD ────────────────────────────────────────────────────
exports.adeGetRules = onCall({ enforceAppCheck: true }, async request => {
  _requireAdmin(request.auth);
  const { eventType } = request.data || {};
  let q = db.collection(C.rules);
  if (eventType) q = q.where('event_type', '==', eventType);
  const snap = await q.get();
  const rules = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return { rules };
});

exports.adeUpsertRule = onCall({ enforceAppCheck: true }, async request => {
  _requireAdmin(request.auth);
  const { id, name, description, event_type, conditions, action, action_params, confidence_threshold, priority, enabled, tags } = request.data;
  if (!name || !event_type || !action)
    throw new HttpsError('invalid-argument', 'name, event_type, action required');
  if (!VALID_EVENTS.includes(event_type))
    throw new HttpsError('invalid-argument', 'Invalid event_type');
  if (!VALID_ACTIONS.includes(action))
    throw new HttpsError('invalid-argument', 'Invalid action');

  const ruleData = {
    name:                 String(name).slice(0, 100),
    description:          String(description || '').slice(0, 500),
    event_type,
    conditions:           Array.isArray(conditions) ? conditions.slice(0, 20) : [],
    action,
    action_params:        action_params && typeof action_params === 'object' ? action_params : {},
    confidence_threshold: Math.min(100, Math.max(0, Number(confidence_threshold) || 70)),
    priority:             Math.min(1000, Math.max(0, Number(priority) || 100)),
    enabled:              enabled !== false,
    tags:                 Array.isArray(tags) ? tags.slice(0, 10).map(String) : [],
    updated_at:           FieldValue.serverTimestamp(),
    updated_by:           request.auth.uid,
  };

  if (id) {
    const existing = await db.collection(C.rules).doc(id).get();
    if (!existing.exists) throw new HttpsError('not-found', 'Rule not found');
    await db.collection(C.rules).doc(id).update(ruleData);
    await _log({ actionType: 'rule_updated', eventType: event_type, entityId: id, entityType: 'rule', decision: 'updated', automated: false, actor: request.auth.uid, trigger: 'admin' });
    return { id };
  }

  const ref = await db.collection(C.rules).add({
    ...ruleData,
    created_at: FieldValue.serverTimestamp(),
    created_by: request.auth.uid,
  });
  await _log({ actionType: 'rule_created', eventType: event_type, entityId: ref.id, entityType: 'rule', decision: 'created', automated: false, actor: request.auth.uid, trigger: 'admin' });
  return { id: ref.id };
});

exports.adeDeleteRule = onCall({ enforceAppCheck: true }, async request => {
  if (!_isSA(request.auth)) throw new HttpsError('permission-denied', 'SuperAdmin required');
  const { id } = request.data;
  if (!id) throw new HttpsError('invalid-argument', 'id required');
  const snap = await db.collection(C.rules).doc(id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Rule not found');
  await db.collection(C.rules).doc(id).delete();
  await _log({ actionType: 'rule_deleted', eventType: snap.data().event_type, entityId: id, entityType: 'rule', decision: 'deleted', automated: false, actor: request.auth.uid, trigger: 'admin' });
  return { success: true };
});

// ─── Callable — Audit Log ─────────────────────────────────────────────────────
exports.adeGetAuditLog = onCall({ enforceAppCheck: true }, async request => {
  _requireAdmin(request.auth);
  const { entityId, eventType, lim = 50 } = request.data || {};
  const limit = Math.min(lim, 200);
  const snap  = await db.collection(C.audit).orderBy('timestamp', 'desc').limit(limit * 3).get();
  let entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (entityId)  entries = entries.filter(e => e.entity_id  === entityId);
  if (eventType) entries = entries.filter(e => e.event_type === eventType);
  return { entries: entries.slice(0, limit) };
});

// ─── Callable — Metrics ───────────────────────────────────────────────────────
exports.adeGetMetrics = onCall({ enforceAppCheck: true }, async request => {
  _requireAdmin(request.auth);
  const since = Timestamp.fromDate(new Date(Date.now() - 7 * 86400000));

  const [decisionsSnap, exceptionsSnap, rulesSnap, jobsSnap] = await Promise.all([
    db.collection(C.decisions).where('timestamp', '>=', since).get(),
    db.collection(C.exceptions).where('created_at', '>=', since).get(),
    db.collection(C.rules).get(),
    db.collection(C.jobs).where('status', '==', 'pending').get(),
  ]);

  const decisions  = decisionsSnap.docs.map(d => d.data());
  const exceptions = exceptionsSnap.docs.map(d => d.data());

  const byDecision  = {};
  const byEventType = {};
  decisions.forEach(d => {
    byDecision[d.decision]    = (byDecision[d.decision]    || 0) + 1;
    byEventType[d.event_type] = (byEventType[d.event_type] || 0) + 1;
  });

  const autoResolved      = decisions.filter(d => d.decision !== 'escalated').length;
  const escalated         = decisions.filter(d => d.decision === 'escalated').length;
  const autoResolutionRate = decisions.length > 0 ? Math.round(autoResolved / decisions.length * 100) : 0;
  const openExceptions    = exceptions.filter(e => e.status === 'open').length;
  const avgConfidence     = decisions.length > 0
    ? Math.round(decisions.reduce((s, d) => s + (d.confidence || 0), 0) / decisions.length) : 0;

  const activeRules  = rulesSnap.docs.filter(d => d.data().enabled !== false).length;
  const totalRules   = rulesSnap.size;
  const overrideRate = decisions.length > 0
    ? Math.round(decisions.filter(d => d.overridden).length / decisions.length * 100) : 0;

  return {
    period: '7d',
    totalDecisions: decisions.length,
    autoResolved,
    escalated,
    autoResolutionRate,
    openExceptions,
    avgConfidence,
    pendingJobs: jobsSnap.size,
    activeRules,
    totalRules,
    overrideRate,
    byDecision,
    byEventType,
  };
});

// ─── Callable — Seed Default Rules (SuperAdmin, one-time) ─────────────────────
exports.adeSeedDefaultRules = onCall({ enforceAppCheck: true }, async request => {
  if (!_isSA(request.auth)) throw new HttpsError('permission-denied', 'SuperAdmin required');
  const existing = await db.collection(C.rules).limit(1).get();
  if (!existing.empty) return { skipped: true, message: 'Rules already seeded' };

  const ts  = FieldValue.serverTimestamp();
  const uid = request.auth.uid;
  const seed = [
    { name: 'Auto-approve standard registration', description: 'Activate all new customer accounts automatically', event_type: 'account_registration', conditions: [], action: 'auto_approve', action_params: { message: 'Welcome to SOKONI! Your account is now active.' }, confidence_threshold: 0, priority: 100, enabled: true, tags: ['accounts'] },
    { name: 'Auto-approve complete seller applications', description: 'Approve sellers who have submitted all required documents', event_type: 'seller_application', conditions: [{ field: 'idDocument', operator: 'exists' }, { field: 'businessAddress', operator: 'exists' }, { field: 'county', operator: 'exists' }], action: 'auto_approve', action_params: { message: 'Seller account approved. Start listing products.' }, confidence_threshold: 65, priority: 200, enabled: true, tags: ['sellers'] },
    { name: 'Escalate incomplete seller applications', description: 'Route sellers with missing documents for manual review', event_type: 'seller_application', conditions: [], action: 'escalate', action_params: { priority: 'medium', recommendation: 'Check submitted documents and approve or request missing info.' }, confidence_threshold: 0, priority: 100, enabled: true, tags: ['sellers'] },
    { name: 'Process completed payments', description: 'Auto-process verified payment completions', event_type: 'payment_received', conditions: [{ field: 'status', operator: 'eq', value: 'completed' }], action: 'auto_approve', action_params: { message: 'Payment confirmed.' }, confidence_threshold: 80, priority: 200, enabled: true, tags: ['payments'] },
    { name: 'Auto-approve small refunds', description: 'Automatically refund amounts under KES 500 with sufficient evidence', event_type: 'refund_request', conditions: [{ field: 'amount', operator: 'lte', value: 50000 }], action: 'auto_approve', action_params: { message: 'Refund approved and will be processed within 24 hours.' }, confidence_threshold: 70, priority: 200, enabled: true, tags: ['refunds'] },
    { name: 'Escalate large refunds', description: 'Refunds above KES 5,000 require finance team approval', event_type: 'refund_request', conditions: [{ field: 'amount', operator: 'gt', value: 500000 }], action: 'escalate', action_params: { priority: 'high', recommendation: 'Large refund. Verify delivery status, payment proof, and user history before approving.' }, confidence_threshold: 0, priority: 300, enabled: true, tags: ['refunds', 'high-value'] },
    { name: 'Auto-approve small withdrawals', description: 'Withdrawals under KES 10,000 from verified accounts', event_type: 'withdrawal', conditions: [{ field: 'amount', operator: 'lte', value: 1000000 }, { field: 'accountVerified', operator: 'truthy' }], action: 'auto_approve', action_params: { message: 'Withdrawal approved. Funds sent within 2 business days.' }, confidence_threshold: 75, priority: 200, enabled: true, tags: ['withdrawals'] },
    { name: 'Escalate large withdrawals', description: 'Withdrawals above KES 50,000 require SuperAdmin sign-off', event_type: 'withdrawal', conditions: [{ field: 'amount', operator: 'gt', value: 5000000 }], action: 'escalate', action_params: { priority: 'high', recommendation: 'High-value withdrawal. Verify account legitimacy and seller history before approving.' }, confidence_threshold: 0, priority: 300, enabled: true, tags: ['withdrawals', 'high-value'] },
    { name: 'Escalate all disputes for review', description: 'Disputes require human judgment based on evidence', event_type: 'dispute', conditions: [], action: 'escalate', action_params: { priority: 'high', recommendation: 'Review delivery records, payment proof, chat history, and photos before deciding.' }, confidence_threshold: 0, priority: 100, enabled: true, tags: ['disputes'] },
    { name: 'Log subscription status changes', description: 'Record all subscription lifecycle transitions', event_type: 'subscription_change', conditions: [], action: 'notify_only', action_params: {}, confidence_threshold: 0, priority: 100, enabled: true, tags: ['subscriptions'] },
    { name: 'Escalate content reports', description: 'Content reports require human moderation review', event_type: 'content_report', conditions: [], action: 'escalate', action_params: { priority: 'medium', recommendation: 'Review flagged content against Community Guidelines. Remove if in violation.' }, confidence_threshold: 0, priority: 100, enabled: true, tags: ['moderation'] },
  ];

  const batch = db.batch();
  seed.forEach(rule => {
    const ref = db.collection(C.rules).doc();
    batch.set(ref, { ...rule, created_at: ts, updated_at: ts, created_by: uid });
  });
  await batch.commit();
  return { seeded: seed.length };
});

// ─── Scheduled — Retry Failed Jobs ────────────────────────────────────────────
exports.adeRetryFailedJobs = onSchedule('every 5 minutes', async () => {
  const now  = Date.now();
  const snap = await db.collection(C.jobs).where('status', '==', 'pending').get();
  const ready = snap.docs
    .filter(d => {
      const j    = d.data();
      const retAt = j.next_retry_at?.toDate?.()?.getTime() || 0;
      return retAt <= now;
    })
    .slice(0, 20);

  await Promise.all(ready.map(async doc => {
    const job = doc.data();
    if (job.attempts >= (job.max_attempts || 3)) {
      await doc.ref.update({ status: 'exhausted', completed_at: FieldValue.serverTimestamp() });
      return;
    }
    await doc.ref.update({ status: 'processing', attempts: FieldValue.increment(1) });
    try {
      const { eventType, entityType, entityId, eventData } = job.payload;
      await _processEvent(eventType, entityType, entityId, eventData || {}, 'retry');
      await doc.ref.update({ status: 'completed', completed_at: FieldValue.serverTimestamp() });
    } catch (err) {
      const nextAttempt = job.attempts + 1;
      const backoff     = Math.min(3600000, 60000 * Math.pow(2, nextAttempt));
      await doc.ref.update({
        status: 'pending',
        error: err.message,
        next_retry_at: Timestamp.fromDate(new Date(now + backoff)),
      });
    }
  }));
});

// ─── Scheduled — Daily Maintenance ───────────────────────────────────────────
exports.adeDailyMaintenance = onSchedule('every day 02:00', async () => {
  const thirtyDaysAgo  = Timestamp.fromDate(new Date(Date.now() - 30  * 86400000));
  const ninetyDaysAgo  = Timestamp.fromDate(new Date(Date.now() - 90  * 86400000));
  const oneYearAgo     = Timestamp.fromDate(new Date(Date.now() - 365 * 86400000));

  // Clean completed/exhausted jobs older than 30 days
  const oldJobs = await db.collection(C.jobs)
    .where('completed_at', '<', thirtyDaysAgo)
    .limit(500)
    .get();
  const jobBatch = db.batch();
  oldJobs.docs.forEach(d => jobBatch.delete(d.ref));
  if (!oldJobs.empty) await jobBatch.commit();

  // Archive resolved exceptions older than 90 days
  const oldExceptions = await db.collection(C.exceptions)
    .where('resolved_at', '<', ninetyDaysAgo)
    .limit(200)
    .get();
  if (!oldExceptions.empty) {
    const excBatch = db.batch();
    oldExceptions.docs.forEach(d => {
      excBatch.set(db.collection('ade_exceptions_archive').doc(d.id), d.data());
      excBatch.delete(d.ref);
    });
    await excBatch.commit();
  }

  // Archive audit entries older than 1 year
  const oldAudit = await db.collection(C.audit)
    .where('timestamp', '<', oneYearAgo)
    .limit(500)
    .get();
  if (!oldAudit.empty) {
    const auditBatch = db.batch();
    oldAudit.docs.forEach(d => {
      auditBatch.set(db.collection('ade_audit_archive').doc(d.id), d.data());
      auditBatch.delete(d.ref);
    });
    await auditBatch.commit();
  }

  console.log(`ADE maintenance: ${oldJobs.size} jobs cleaned, ${oldExceptions.size} exceptions archived, ${oldAudit.size} audit entries archived`);
});
