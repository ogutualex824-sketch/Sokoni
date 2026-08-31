/* ================================================================
   SOKONI — Intelligent Automation & Decision Engine  v1.0
   functions/automation-engine.js

   15 Cloud Functions (6 triggers + 2 scheduled + 7 callable)

   Firestore Triggers:
     autoOnAccountCreate       — users/{uid} created → activate
     autoOnSellerApplication   — sellerApplications/{id} → approve/queue
     autoOnDisputeCreate       — disputes/{id} → AI resolution/escalate
     autoOnRefundRequest       — refundRequests/{id} → auto-approve/queue
     autoOnApprovalRequest     — approvalRequests/{id} → route by risk
     autoOnSubscriptionCreate  — subscriptions/{id} → activate lifecycle

   Scheduled:
     autoScheduledPayouts      — every 6 hours → process eligible payouts
     autoScheduledMaintenance  — every 24 hours → archive + cleanup + retry

   Callable (admin):
     autoGetExceptionQueue      — list pending exceptions
     autoResolveException       — resolve with override tracking
     autoGetRules               — fetch all business rules
     autoUpdateRule             — update single rule category
     autoGetAuditLog            — paginated audit trail
     autoGetStatus              — engine health and stats
     autoTriggerMaintenance     — on-demand maintenance run

   Collections:
     automationRules/{category}   — configurable thresholds
     automationQueue              — items requiring human review
     automationAuditLog           — immutable automated action trail
================================================================ */
'use strict';

const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onDocumentCreated }  = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');
const logger                 = require('firebase-functions/logger');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/* ── Shared helpers ──────────────────────────────────────────── */
const _db  = () => admin.firestore();
const _ts  = () => admin.firestore.FieldValue.serverTimestamp();
const _inc = (n) => admin.firestore.FieldValue.increment(n);

const _cfg    = { enforceAppCheck: true, region: 'us-central1', memory: '256MiB' };
const _cfgAI  = { enforceAppCheck: true, region: 'us-central1', memory: '512MiB', timeoutSeconds: 120, secrets: [ANTHROPIC_API_KEY] };
const _trCfg  = { region: 'us-central1', memory: '256MiB' };
const _trAICfg = { region: 'us-central1', memory: '512MiB', timeoutSeconds: 120, secrets: [ANTHROPIC_API_KEY] };

function _assertAdmin(req) {
  const t = req.auth?.token ?? {};
  if (!t.admin && !t.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required.');
  return req.auth.uid;
}

/* Default business rules per category — used when Firestore doc absent */
function _defaultRules() {
  return {
    withdrawals: {
      autoApproveBelow: 5000,
      requireManualAbove: 50000,
      enabled: true,
      description: 'Seller withdrawal requests',
    },
    refunds: {
      autoApproveBelow: 2000,
      requireManualAbove: 20000,
      enabled: true,
      description: 'Buyer refund requests',
    },
    seller_application: {
      autoApproveStandardDocs: true,
      maxDaysToProcess: 2,
      enabled: true,
      description: 'New seller onboarding applications',
    },
    account_activation: {
      autoActivate: true,
      requireEmailVerify: false,
      enabled: true,
      description: 'New user account activation',
    },
    subscriptions: {
      autoRenew: true,
      gracePeriodDays: 3,
      enabled: true,
      description: 'Subscription lifecycle management',
    },
    disputes: {
      autoResolveBelow: 1000,
      evidenceWindowHours: 48,
      enabled: true,
      description: 'Order and payment disputes',
    },
    payouts: {
      autoProcessBelow: 100000,
      holdDays: 2,
      enabled: true,
      description: 'Seller payout scheduling',
    },
    archival: {
      orderRetentionDays: 90,
      logRetentionDays: 30,
      jobRetryLimit: 3,
      enabled: true,
      description: 'Data archival and maintenance policy',
    },
  };
}

async function _getRule(category) {
  const snap = await _db().collection('automationRules').doc(category).get().catch(() => null);
  const defaults = _defaultRules();
  const base = defaults[category] || { enabled: true };
  if (!snap?.exists) return base;
  return { ...base, ...snap.data() };
}

async function _logAction(data) {
  try {
    await _db().collection('automationAuditLog').add({
      ...data,
      automated: true,
      humanOverride: false,
      createdAt: _ts(),
    });
  } catch (e) {
    logger.error('automation: failed to write audit log', { error: e.message });
  }
}

async function _queueException(item) {
  try {
    const ref = await _db().collection('automationQueue').add({
      ...item,
      status: 'pending',
      automationAttempted: true,
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: _ts(),
    });
    return ref.id;
  } catch (e) {
    logger.error('automation: failed to queue exception', { error: e.message, type: item.type });
    return null;
  }
}

async function _notify(uid, title, body, data = {}) {
  try {
    await _db().collection('notifications').add({
      userId: uid, title, body, data,
      read: false, type: 'automation', priority: 'normal',
      createdAt: _ts(),
    });
  } catch (_) { /* notification failures must not block automation */ }
}

/* ── Account Lifecycle ───────────────────────────────────────── */

exports.autoOnAccountCreate = onDocumentCreated(
  { document: 'users/{uid}', region: 'us-central1', memory: '256MiB' },
  async (event) => {
    const uid  = event.params.uid;
    const user = event.data?.data();
    if (!user) return;
    if (user.automationProcessed) return;

    const rule = await _getRule('account_activation');
    if (!rule.enabled) return;

    const isSocialAuth = user.authProvider && user.authProvider !== 'email';
    const isVerified   = user.emailVerified || isSocialAuth;
    const shouldActivate = rule.autoActivate && (!rule.requireEmailVerify || isVerified);
    const status = shouldActivate ? 'active' : 'pending_verification';

    await event.data.ref.update({
      status,
      automationProcessed: true,
      activatedAt: shouldActivate ? _ts() : null,
      activatedBy: shouldActivate ? 'automation' : null,
    }).catch(e => logger.error('autoOnAccountCreate: update failed', { uid, error: e.message }));

    await _logAction({
      action: 'auto_activate_account',
      trigger: 'user_created',
      ruleApplied: 'account_activation',
      entityId: uid,
      entityType: 'user',
      outcome: status,
      metadata: { authProvider: user.authProvider || 'email', autoActivated: shouldActivate },
    });

    if (shouldActivate) {
      await _notify(uid, 'Welcome to SOKONI!',
        'Your account is active. Start exploring the marketplace.', { type: 'account_activated' });
    }
  }
);

/* ── Subscription Lifecycle ──────────────────────────────────── */

exports.autoOnSubscriptionCreate = onDocumentCreated(
  { document: 'subscriptions/{subId}', region: 'us-central1', memory: '256MiB' },
  async (event) => {
    const subId = event.params.subId;
    const sub   = event.data?.data();
    if (!sub || sub.automationProcessed) return;

    const rule = await _getRule('subscriptions');
    if (!rule.enabled) return;

    const cycleDays  = sub.billingCycleDays || 30;
    const trialDays  = sub.trialDays || 0;
    const endDate    = new Date();
    endDate.setDate(endDate.getDate() + cycleDays + trialDays);
    const status = trialDays > 0 ? 'trialing' : 'active';

    await event.data.ref.update({
      status,
      currentPeriodStart: _ts(),
      currentPeriodEnd: admin.firestore.Timestamp.fromDate(endDate),
      automationProcessed: true,
      activatedBy: 'automation',
    }).catch(e => logger.error('autoOnSubscriptionCreate: update failed', { subId, error: e.message }));

    await _logAction({
      action: 'auto_activate_subscription',
      trigger: 'subscription_created',
      ruleApplied: 'subscriptions',
      entityId: subId,
      entityType: 'subscription',
      outcome: status,
      metadata: { plan: sub.plan, uid: sub.userId, trialDays },
    });

    await _notify(sub.userId, 'Subscription Activated',
      `Your ${sub.plan || 'SOKONI'} plan is now ${status}. Enjoy your benefits!`,
      { subscriptionId: subId, type: 'subscription_activated' });
  }
);

/* ── Seller Onboarding ───────────────────────────────────────── */

exports.autoOnSellerApplication = onDocumentCreated(
  { document: 'sellerApplications/{appId}', region: 'us-central1', memory: '256MiB' },
  async (event) => {
    const appId = event.params.appId;
    const app   = event.data?.data();
    if (!app || app.automationProcessed) return;

    await event.data.ref.update({ automationProcessed: true });

    const rule = await _getRule('seller_application');
    if (!rule.enabled) return;

    const requiredFields = ['businessName', 'phone'];
    const hasRequiredFields = requiredFields.every(f => app[f] || app.documents?.[f]);
    const hasIdDoc = !!(app.idDocumentUrl || app.documents?.id_document);
    const autoApprove = rule.autoApproveStandardDocs && hasRequiredFields && hasIdDoc;

    if (autoApprove) {
      await _db().runTransaction(async tx => {
        tx.update(event.data.ref, {
          status: 'approved',
          approvedAt: _ts(),
          approvedBy: 'automation',
        });
        tx.set(_db().collection('users').doc(app.userId), {
          role: 'seller',
          sellerEnabled: true,
          sellerApplicationId: appId,
          sellerApprovedAt: _ts(),
        }, { merge: true });
        tx.set(_db().collection('shops').doc(app.userId), {
          ownerId: app.userId,
          businessName: app.businessName,
          status: 'active',
          paymentEnabled: true,
          commEnabled: true,
          posEnabled: false,
          createdAt: _ts(),
          createdBy: 'automation',
        }, { merge: true });
      });

      await _logAction({
        action: 'auto_approve_seller',
        trigger: 'seller_application_created',
        ruleApplied: 'seller_application',
        entityId: appId,
        entityType: 'seller_application',
        outcome: 'approved',
        metadata: { uid: app.userId, businessName: app.businessName },
      });

      await _notify(app.userId, 'Seller Account Approved!',
        'Congratulations! Your seller account is active. You can now list products and accept orders.',
        { type: 'seller_approved', applicationId: appId });

    } else {
      await event.data.ref.update({ status: 'under_review' });

      const missingDocs = [];
      if (!hasRequiredFields) missingDocs.push('business name or phone');
      if (!hasIdDoc) missingDocs.push('identity document');

      const queueId = await _queueException({
        type: 'verification_failure',
        priority: 'medium',
        entityId: appId,
        entityType: 'seller_application',
        title: `Seller Application — ${app.businessName || 'Unnamed Business'}`,
        description: `Missing: ${missingDocs.join(', ')}. Manual document verification required.`,
        recommendation: {
          action: 'contact_applicant',
          confidence: 0.65,
          reasoning: `Application incomplete. Contact ${app.businessName || 'applicant'} to provide: ${missingDocs.join(', ')}. Approve once received and verified.`,
          suggestedAction: 'Send verification request email and approve once documents are received.',
        },
        evidence: [
          { type: 'application_data', label: 'Application', data: { userId: app.userId, businessName: app.businessName, hasIdDoc, hasRequiredFields } },
        ],
      });

      await _logAction({
        action: 'queue_seller_application',
        trigger: 'seller_application_created',
        ruleApplied: 'seller_application',
        entityId: appId,
        entityType: 'seller_application',
        outcome: 'queued_for_review',
        metadata: { queueId, missingDocs },
      });

      await _notify(app.userId, 'Application Under Review',
        'Your seller application is being reviewed. We will notify you within 2 business days.',
        { type: 'seller_application_reviewing', applicationId: appId });
    }
  }
);

/* ── Dispute Resolution (AI-powered) ────────────────────────── */

exports.autoOnDisputeCreate = onDocumentCreated(
  { document: 'disputes/{disputeId}', region: 'us-central1', memory: '512MiB', timeoutSeconds: 120, secrets: [ANTHROPIC_API_KEY] },
  async (event) => {
    const disputeId = event.params.disputeId;
    const dispute   = event.data?.data();
    if (!dispute || dispute.automationProcessed) return;

    await event.data.ref.update({ automationProcessed: true, status: 'under_review' });

    const rule   = await _getRule('disputes');
    if (!rule.enabled) return;

    const amount = Number(dispute.amount || 0);

    /* Gather evidence in parallel */
    const [orderSnap, paymentSnap] = await Promise.all([
      dispute.orderId ? _db().collection('orders').doc(dispute.orderId).get().catch(() => null) : null,
      dispute.paymentId ? _db().collection('payments').doc(dispute.paymentId).get().catch(() => null) : null,
    ]);

    const evidence = [];
    let order = null, payment = null, delivery = null;

    if (orderSnap?.exists) {
      order = orderSnap.data();
      evidence.push({ type: 'order', label: 'Order', data: { status: order.status, total: order.total, hub: order.hub } });
    }
    if (paymentSnap?.exists) {
      payment = paymentSnap.data();
      evidence.push({ type: 'payment', label: 'Payment', data: { status: payment.status, amount: payment.amount, method: payment.method } });
    }

    if (dispute.orderId) {
      const ds = await _db().collection('deliveries')
        .where('orderId', '==', dispute.orderId).limit(1).get().catch(() => null);
      if (ds && !ds.empty) {
        delivery = ds.docs[0].data();
        evidence.push({ type: 'delivery', label: 'Delivery', data: { status: delivery.status, completedAt: delivery.completedAt } });
      }
    }

    /* Small, clear-evidence disputes → auto-resolve */
    const isSmall = amount <= (rule.autoResolveBelow || 1000);
    const paymentConfirmed = payment?.status === 'completed';
    const deliveryConfirmed = delivery?.status === 'delivered';

    if (isSmall && paymentConfirmed) {
      const resolution = (dispute.type === 'not_received' && deliveryConfirmed) ? 'seller_wins' : 'buyer_wins';

      await _db().runTransaction(async tx => {
        tx.update(event.data.ref, {
          status: 'resolved',
          resolution,
          resolvedAt: _ts(),
          resolvedBy: 'automation',
          automationReasoning: 'Amount below auto-resolve threshold with clear payment evidence.',
        });
        if (resolution === 'buyer_wins') {
          const refRef = _db().collection('refundRequests').doc();
          tx.set(refRef, {
            orderId: dispute.orderId || null,
            disputeId,
            buyerUid: dispute.buyerId,
            sellerUid: dispute.sellerId,
            amount,
            reason: 'dispute_auto_resolved_buyer_wins',
            status: 'approved',
            approvedBy: 'automation',
            createdAt: _ts(),
          });
        }
      });

      await _logAction({
        action: 'auto_resolve_dispute',
        trigger: 'dispute_created',
        ruleApplied: 'disputes',
        entityId: disputeId,
        entityType: 'dispute',
        outcome: resolution,
        metadata: { amount, evidenceTypes: evidence.map(e => e.type), resolution },
      });

      const winnerMsg = resolution === 'buyer_wins' ? 'in your favour' : 'in favour of the seller';
      await Promise.all([
        _notify(dispute.buyerId,  'Dispute Resolved', `Your dispute has been resolved ${winnerMsg}. ${resolution === 'buyer_wins' ? 'A refund has been issued.' : ''}`, { disputeId }),
        _notify(dispute.sellerId, 'Dispute Resolved', `Dispute resolved. Decision: ${resolution.replace(/_/g, ' ')}.`, { disputeId }),
      ]);
      return;
    }

    /* Higher-value or ambiguous → AI recommendation + queue */
    let recommendation = {
      action: 'manual_review',
      confidence: 0.5,
      reasoning: `Dispute of KES ${amount} exceeds auto-resolve threshold of KES ${rule.autoResolveBelow}. Human review with full evidence required.`,
      suggestedAction: 'Review order fulfilment, delivery proof, and communication history before deciding.',
    };

    const apiKey = ANTHROPIC_API_KEY.value();
    if (apiKey) {
      try {
        const fetch = (await import('node-fetch')).default;
        const systemPrompt = `You are a neutral dispute mediator for SOKONI, a Kenyan marketplace.
Analyse the evidence and return ONLY valid JSON with keys: action, confidence (0-1), reasoning, suggestedAction.
Actions: buyer_wins | seller_wins | split | manual_review.
Default to manual_review if evidence is ambiguous. Be concise and fair.`;

        const userPrompt = `Dispute: type=${dispute.type || 'general'}, amount=KES ${amount}, reason="${dispute.reason || 'Not specified'}"
Evidence: ${JSON.stringify(evidence)}
Payment confirmed: ${paymentConfirmed}. Delivery confirmed: ${deliveryConfirmed}.
Auto-resolve threshold: KES ${rule.autoResolveBelow}.`;

        const res  = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        });

        const json   = await res.json();
        const text   = json.content?.[0]?.text || '';
        const match  = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (parsed.action && typeof parsed.confidence === 'number') {
            recommendation = parsed;
          }
        }
      } catch (e) {
        logger.warn('autoOnDisputeCreate: AI recommendation failed, using default', { error: e.message });
      }
    }

    const priority = amount > 50000 ? 'critical' : amount > 10000 ? 'high' : 'medium';
    const queueId = await _queueException({
      type: 'dispute',
      priority,
      entityId: disputeId,
      entityType: 'dispute',
      title: `Dispute: ${dispute.reason || 'General'} — KES ${amount}`,
      description: `${dispute.type || 'Dispute'} between buyer and seller. AI recommends: ${recommendation.action} (${Math.round((recommendation.confidence || 0) * 100)}% confidence).`,
      recommendation,
      evidence,
    });

    await _logAction({
      action: 'escalate_dispute',
      trigger: 'dispute_created',
      ruleApplied: 'disputes',
      entityId: disputeId,
      entityType: 'dispute',
      outcome: 'escalated_to_queue',
      metadata: { amount, priority, queueId, recommendedAction: recommendation.action },
    });

    await Promise.all([
      _notify(dispute.buyerId,  'Dispute Under Review', 'Your dispute is being reviewed by our team. We\'ll notify you of the decision within 48 hours.', { disputeId }),
      _notify(dispute.sellerId, 'Dispute Raised', `A dispute has been raised for your order. Our team is reviewing it.`, { disputeId }),
    ]);
  }
);

/* ── Refund Processing ───────────────────────────────────────── */

exports.autoOnRefundRequest = onDocumentCreated(
  { document: 'refundRequests/{refId}', region: 'us-central1', memory: '256MiB' },
  async (event) => {
    const refId  = event.params.refId;
    const refund = event.data?.data();
    if (!refund || refund.automationProcessed) return;
    if (refund.status !== 'pending') return;

    await event.data.ref.update({ automationProcessed: true });

    const rule   = await _getRule('refunds');
    if (!rule.enabled) return;

    const amount = Number(refund.amount || 0);

    if (amount <= (rule.autoApproveBelow || 2000)) {
      /* F9 refund-safety (DISARMED): this branch formerly AUTO-CREDITED the buyer's
         `users.walletBalance` (a display-only field the withdrawal engine does NOT
         spend — payout reads `wallets.balance`) with a single-sided `ledger` row and
         NO seller debit, i.e. a second, uncoordinated refund authority that moved
         money outside the canonical settlement-reversal path. It is disarmed: a small
         auto-resolved refund now moves NO money here and is routed to the SAME
         operator queue as a high-value refund, so it is honestly surfaced for
         authorized execution rather than marked paid. Do NOT re-add a wallet credit
         here — the canonical seller-debit refund is `order-settlement.handleOrderRefund`
         (separate, lineage-gated). */
      await event.data.ref.update({ status: 'under_review' });

      const queueId = await _queueException({
        type: 'auto_refund_pending_execution',
        priority: 'normal',
        entityId: refId,
        entityType: 'refund',
        title: `Refund pending execution — KES ${amount.toLocaleString()}`,
        description: `Auto-resolved small refund (KES ${amount.toLocaleString()}) awaiting authorized execution. No funds have been moved.`,
        recommendation: {
          action: 'execute_refund',
          confidence: 0.60,
          reasoning: 'Auto-resolved below the manual threshold. Execute via the canonical refund path (seller debit + settlement reversal). No wallet credit has been applied.',
          suggestedAction: `Execute the refund for order ${refund.orderId || 'N/A'} via the canonical refund flow.`,
        },
        evidence: [
          { type: 'refund_request', label: 'Refund', data: { amount, reason: refund.reason, orderId: refund.orderId } },
        ],
      });

      await _logAction({
        action: 'queue_auto_refund',
        trigger: 'refund_requested',
        ruleApplied: 'refunds',
        entityId: refId,
        entityType: 'refund',
        outcome: 'queued_for_execution',
        metadata: { amount, buyerUid: refund.buyerUid, reason: refund.reason, queueId },
      });

      await _notify(refund.buyerUid, 'Refund Request Received',
        `Your refund request of KES ${amount.toLocaleString()} has been received and is being processed. We'll notify you once it is completed.`,
        { refundId: refId, type: 'refund_pending' });

    } else if (amount >= (rule.requireManualAbove || 20000)) {
      await event.data.ref.update({ status: 'under_review' });

      const queueId = await _queueException({
        type: 'high_value_refund',
        priority: amount > 100000 ? 'critical' : 'high',
        entityId: refId,
        entityType: 'refund',
        title: `High-Value Refund — KES ${amount.toLocaleString()}`,
        description: `Refund of KES ${amount.toLocaleString()} exceeds the KES ${rule.requireManualAbove.toLocaleString()} manual-review threshold.`,
        recommendation: {
          action: 'approve_refund',
          confidence: 0.70,
          reasoning: 'Verify the original order was fulfilled before releasing. Check for duplicate refund requests and fraud signals.',
          suggestedAction: `Confirm order ${refund.orderId || 'N/A'} was not fulfilled before approving refund.`,
        },
        evidence: [
          { type: 'refund_request', label: 'Refund', data: { amount, reason: refund.reason, orderId: refund.orderId } },
        ],
      });

      await _logAction({
        action: 'queue_high_value_refund',
        trigger: 'refund_requested',
        ruleApplied: 'refunds',
        entityId: refId,
        entityType: 'refund',
        outcome: 'queued_for_review',
        metadata: { amount, queueId },
      });

      await _notify(refund.buyerUid, 'Refund Under Review',
        'Your refund request requires additional review. We\'ll notify you within 48 hours.',
        { refundId: refId, type: 'refund_reviewing' });
    }
    /* Amounts between thresholds → standard queue, no auto-action */
  }
);

/* ── Approval Workflow Routing ───────────────────────────────── */

exports.autoOnApprovalRequest = onDocumentCreated(
  { document: 'approvalRequests/{reqId}', region: 'us-central1', memory: '256MiB' },
  async (event) => {
    const reqId = event.params.reqId;
    const req   = event.data?.data();
    if (!req || req.automationProcessed) return;

    await event.data.ref.update({ automationProcessed: true });

    const { type, amount = 0, riskScore = 0, entityId, userId } = req;
    const amountNum  = Number(amount);
    const riskNum    = Number(riskScore);

    /* Low-risk auto-approve */
    const isLowRisk = riskNum < 30 && amountNum < 10000 &&
      ['listing_publish', 'content_update', 'profile_update'].includes(type);

    if (isLowRisk) {
      await event.data.ref.update({ status: 'approved', approvedBy: 'automation', approvedAt: _ts() });

      await _logAction({
        action: 'auto_approve_request',
        trigger: 'approval_request_created',
        ruleApplied: 'approval_workflow',
        entityId: reqId,
        entityType: 'approval_request',
        outcome: 'approved',
        metadata: { type, riskScore: riskNum, amount: amountNum },
      });

      if (userId) {
        await _notify(userId, 'Request Approved', `Your ${type?.replace(/_/g, ' ')} request has been approved.`, { requestId: reqId });
      }
      return;
    }

    /* High-risk → queue with recommendation */
    const priority = riskNum > 70 || amountNum > 50000 ? 'high' : 'medium';
    const queueId = await _queueException({
      type: 'approval_required',
      priority,
      entityId: reqId,
      entityType: 'approval_request',
      title: `Approval Required: ${type?.replace(/_/g, ' ') || 'Request'}`,
      description: `Risk score: ${riskNum}. Amount: KES ${amountNum.toLocaleString()}. Manual review required.`,
      recommendation: {
        action: riskNum > 70 ? 'reject' : 'approve',
        confidence: riskNum > 70 ? 0.75 : 0.60,
        reasoning: riskNum > 70
          ? `High risk score (${riskNum}). Review thoroughly for fraud or policy violations.`
          : `Moderate risk. Verify entity ${entityId} against platform policies.`,
        suggestedAction: 'Review associated entity and user history before deciding.',
      },
      evidence: [
        { type: 'approval_request', label: 'Request', data: { type, riskScore: riskNum, amount: amountNum, userId, entityId } },
      ],
    });

    await event.data.ref.update({ status: 'queued', queueId });

    await _logAction({
      action: 'queue_approval_request',
      trigger: 'approval_request_created',
      ruleApplied: 'approval_workflow',
      entityId: reqId,
      entityType: 'approval_request',
      outcome: 'queued',
      metadata: { type, riskNum, amountNum, queueId },
    });
  }
);

/* ── Payout Scheduler ────────────────────────────────────────── */

exports.autoScheduledPayouts = onSchedule(
  { schedule: 'every 6 hours', region: 'us-central1', memory: '256MiB', timeoutSeconds: 300 },
  async () => {
    const rule     = await _getRule('payouts');
    if (!rule.enabled) return;

    const holdMs   = (rule.holdDays || 2) * 86400000;
    const cutoff   = new Date(Date.now() - holdMs);
    const maxAuto  = rule.autoProcessBelow || 100000;

    const snap = await _db().collection('payouts')
      .where('status', '==', 'pending')
      .where('requestedAt', '<=', admin.firestore.Timestamp.fromDate(cutoff))
      .limit(50)
      .get().catch(e => { logger.error('autoScheduledPayouts: query failed', { error: e.message }); return null; });

    if (!snap || snap.empty) return;

    let processed = 0, queued = 0;

    await Promise.all(snap.docs.map(async doc => {
      const payout = doc.data();
      const amt = Number(payout.amount || 0);

      if (amt <= maxAuto) {
        await doc.ref.update({
          status: 'processing',
          scheduledAt: _ts(),
          processedBy: 'automation',
        }).catch(() => {});

        await _logAction({
          action: 'auto_schedule_payout',
          trigger: 'scheduled_payout_run',
          ruleApplied: 'payouts',
          entityId: doc.id,
          entityType: 'payout',
          outcome: 'scheduled',
          metadata: { amount: amt, sellerId: payout.sellerId },
        });

        await _notify(payout.sellerId, 'Payout Processing',
          `Your payout of KES ${amt.toLocaleString()} is being processed. Expect M-Pesa confirmation shortly.`,
          { payoutId: doc.id });
        processed++;

      } else {
        await _queueException({
          type: 'high_value_payout',
          priority: amt > 500000 ? 'critical' : 'high',
          entityId: doc.id,
          entityType: 'payout',
          title: `High-Value Payout — KES ${amt.toLocaleString()}`,
          description: `Payout of KES ${amt.toLocaleString()} exceeds the auto-process limit of KES ${maxAuto.toLocaleString()}.`,
          recommendation: {
            action: 'approve_payout',
            confidence: 0.85,
            reasoning: 'Verify seller identity, recent order history, and check for fraud signals before releasing.',
            suggestedAction: `Confirm KYC for seller ${payout.sellerId} and approve after verification.`,
          },
          evidence: [
            { type: 'payout_request', label: 'Payout', data: { amount: amt, sellerId: payout.sellerId, accountNo: payout.accountNo } },
          ],
        });
        queued++;
      }
    }));

    logger.info('autoScheduledPayouts: completed', { processed, queued, total: snap.size });

    await _logAction({
      action: 'scheduled_payout_batch',
      trigger: 'schedule',
      ruleApplied: 'payouts',
      entityId: 'batch',
      entityType: 'system',
      outcome: 'completed',
      metadata: { processed, queued, total: snap.size },
    });
  }
);

/* ── Maintenance & Archival ──────────────────────────────────── */

exports.autoScheduledMaintenance = onSchedule(
  { schedule: 'every 24 hours', region: 'us-central1', memory: '512MiB', timeoutSeconds: 540 },
  async () => {
    const rule       = await _getRule('archival');
    const retainDays = rule.orderRetentionDays || 90;
    const cutoff     = new Date(Date.now() - retainDays * 86400000);

    /* Archive completed orders */
    let archived = 0;
    try {
      const oldOrders = await _db().collection('orders')
        .where('status', '==', 'completed')
        .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(cutoff))
        .limit(100).get();

      if (!oldOrders.empty) {
        const batch = _db().batch();
        oldOrders.docs.forEach(doc => {
          batch.set(_db().collection('archivedOrders').doc(doc.id), {
            ...doc.data(),
            archivedAt: _ts(),
          });
          batch.delete(doc.ref);
        });
        await batch.commit();
        archived = oldOrders.size;
      }
    } catch (e) {
      logger.warn('autoScheduledMaintenance: archive failed', { error: e.message });
    }

    /* Retry failed async jobs */
    let retried = 0;
    try {
      const retryLimit = rule.jobRetryLimit || 3;
      const failedJobs = await _db().collection('asyncJobs')
        .where('status', '==', 'failed')
        .where('retryCount', '<', retryLimit)
        .limit(20).get();

      if (!failedJobs.empty) {
        const batch2 = _db().batch();
        failedJobs.docs.forEach(doc => {
          batch2.update(doc.ref, {
            status: 'pending',
            retryCount: _inc(1),
            scheduledAt: _ts(),
          });
        });
        await batch2.commit();
        retried = failedJobs.size;
      }
    } catch (e) {
      logger.warn('autoScheduledMaintenance: job retry failed', { error: e.message });
    }

    /* Expire stale exception queue items older than 30 days */
    let expired = 0;
    try {
      const queueCutoff = new Date(Date.now() - 30 * 86400000);
      const staleItems = await _db().collection('automationQueue')
        .where('status', '==', 'pending')
        .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(queueCutoff))
        .limit(50).get();

      if (!staleItems.empty) {
        const batch3 = _db().batch();
        staleItems.docs.forEach(doc => {
          batch3.update(doc.ref, { status: 'expired', expiredAt: _ts() });
        });
        await batch3.commit();
        expired = staleItems.size;
      }
    } catch (e) {
      logger.warn('autoScheduledMaintenance: queue expiry failed', { error: e.message });
    }

    logger.info('autoScheduledMaintenance: completed', { archived, retried, expired });

    await _logAction({
      action: 'scheduled_maintenance',
      trigger: 'schedule',
      ruleApplied: 'archival',
      entityId: 'maintenance_run',
      entityType: 'system',
      outcome: 'completed',
      metadata: { archivedOrders: archived, retriedJobs: retried, expiredQueueItems: expired },
    });
  }
);

/* ── Exception Queue — Admin ─────────────────────────────────── */

exports.autoGetExceptionQueue = onCall(_cfg, async ({ data, auth }) => {
  _assertAdmin({ auth });
  const { status = 'pending', priority, type, limit: lim = 50 } = data || {};

  let q = _db().collection('automationQueue');
  if (status)   q = q.where('status', '==', status);
  if (priority) q = q.where('priority', '==', priority);
  if (type)     q = q.where('type', '==', type);

  const snap = await q.orderBy('createdAt', 'desc').limit(Math.min(lim, 100)).get();
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    total: snap.size,
  };
});

exports.autoResolveException = onCall(_cfg, async ({ data, auth }) => {
  const adminUid = _assertAdmin({ auth });
  const { itemId, action, note = '', override = false } = data || {};

  if (!itemId) throw new HttpsError('invalid-argument', 'itemId required.');
  if (!action) throw new HttpsError('invalid-argument', 'action required.');

  const ref  = _db().collection('automationQueue').doc(itemId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Exception item not found.');

  const item = snap.data();
  await ref.update({
    status: 'resolved',
    resolution: action,
    resolutionNote: note,
    resolvedBy: adminUid,
    overrodeRecommendation: override === true,
    resolvedAt: _ts(),
  });

  await _logAction({
    action: 'human_resolve_exception',
    trigger: 'admin_action',
    ruleApplied: 'manual_override',
    entityId: itemId,
    entityType: 'exception_queue_item',
    outcome: action,
    humanOverride: override === true,
    metadata: {
      adminUid,
      note: note.substring(0, 200),
      recommendedAction: item.recommendation?.action,
      followedRecommendation: !override,
    },
  });

  return { success: true };
});

/* ── Business Rules — Admin ──────────────────────────────────── */

exports.autoGetRules = onCall(_cfg, async ({ auth }) => {
  _assertAdmin({ auth });
  const snap    = await _db().collection('automationRules').get();
  const fromDb  = {};
  snap.docs.forEach(d => { fromDb[d.id] = d.data(); });
  const defaults = _defaultRules();
  const merged   = {};
  Object.keys(defaults).forEach(k => {
    merged[k] = { ...defaults[k], ...(fromDb[k] || {}) };
  });
  Object.keys(fromDb).forEach(k => {
    if (!merged[k]) merged[k] = fromDb[k];
  });
  return { rules: merged };
});

exports.autoUpdateRule = onCall(_cfg, async ({ data, auth }) => {
  const adminUid = _assertAdmin({ auth });
  const { category, updates } = data || {};

  if (!category) throw new HttpsError('invalid-argument', 'category required.');
  if (!updates || typeof updates !== 'object') throw new HttpsError('invalid-argument', 'updates object required.');

  /* Validate numeric thresholds */
  const numericFields = [
    'autoApproveBelow', 'requireManualAbove', 'holdDays', 'gracePeriodDays',
    'orderRetentionDays', 'logRetentionDays', 'autoResolveBelow', 'autoProcessBelow',
    'maxDaysToProcess', 'jobRetryLimit', 'evidenceWindowHours',
  ];
  numericFields.forEach(f => {
    if (updates[f] !== undefined) {
      const v = Number(updates[f]);
      if (isNaN(v) || v < 0) throw new HttpsError('invalid-argument', `${f} must be a non-negative number.`);
      updates[f] = v;
    }
  });

  /* Ensure boolean fields stay boolean */
  ['autoApproveStandardDocs', 'autoActivate', 'requireEmailVerify', 'autoRenew', 'enabled'].forEach(f => {
    if (updates[f] !== undefined) updates[f] = Boolean(updates[f]);
  });

  await _db().collection('automationRules').doc(category).set({
    ...updates,
    updatedBy: adminUid,
    updatedAt: _ts(),
  }, { merge: true });

  await _logAction({
    action: 'update_automation_rule',
    trigger: 'admin_action',
    ruleApplied: category,
    entityId: category,
    entityType: 'automation_rule',
    outcome: 'updated',
    metadata: { adminUid, category, updatedFields: Object.keys(updates) },
  });

  return { success: true, category };
});

/* ── Audit Log — Admin ───────────────────────────────────────── */

exports.autoGetAuditLog = onCall(_cfg, async ({ data, auth }) => {
  _assertAdmin({ auth });
  const { action, entityType, entityId, limit: lim = 50, startAfter } = data || {};

  let q = _db().collection('automationAuditLog');
  if (action)     q = q.where('action', '==', action);
  if (entityType) q = q.where('entityType', '==', entityType);
  if (entityId)   q = q.where('entityId', '==', entityId);

  q = q.orderBy('createdAt', 'desc').limit(Math.min(lim, 200));

  if (startAfter) {
    const cursor = await _db().collection('automationAuditLog').doc(startAfter).get();
    if (cursor.exists) q = q.startAfter(cursor);
  }

  const snap = await q.get();
  return {
    logs: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastId: snap.docs.length ? snap.docs[snap.docs.length - 1].id : null,
  };
});

/* ── Engine Status — Admin ───────────────────────────────────── */

exports.autoGetStatus = onCall(_cfg, async ({ auth }) => {
  _assertAdmin({ auth });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [queueSnap, auditTodaySnap, rulesSnap] = await Promise.all([
    _db().collection('automationQueue').where('status', '==', 'pending').get(),
    _db().collection('automationAuditLog')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(todayStart))
      .get(),
    _db().collection('automationRules').get(),
  ]);

  const queueByPriority = { critical: 0, high: 0, medium: 0, low: 0 };
  const queueByType     = {};
  queueSnap.docs.forEach(d => {
    const item = d.data();
    queueByPriority[item.priority || 'medium']++;
    queueByType[item.type || 'other'] = (queueByType[item.type || 'other'] || 0) + 1;
  });

  return {
    queueSize:       queueSnap.size,
    queueByPriority,
    queueByType,
    automatedToday:  auditTodaySnap.size,
    rulesConfigured: rulesSnap.size,
    modules: [
      { name: 'Account Lifecycle',    trigger: 'user_created',              status: 'active' },
      { name: 'Subscription Engine',  trigger: 'subscription_created',      status: 'active' },
      { name: 'Seller Onboarding',    trigger: 'seller_application_created',status: 'active' },
      { name: 'Dispute Resolution',   trigger: 'dispute_created',           status: 'active' },
      { name: 'Refund Processing',    trigger: 'refund_requested',          status: 'active' },
      { name: 'Approval Workflows',   trigger: 'approval_request_created',  status: 'active' },
      { name: 'Payout Scheduler',     trigger: 'every 6 hours',            status: 'active' },
      { name: 'Maintenance Engine',   trigger: 'every 24 hours',           status: 'active' },
    ],
  };
});

/* ── On-demand Maintenance — Admin ───────────────────────────── */

exports.autoTriggerMaintenance = onCall(_cfg, async ({ auth }) => {
  _assertAdmin({ auth });

  const rule = await _getRule('archival');
  const cutoff = new Date(Date.now() - (rule.orderRetentionDays || 90) * 86400000);

  const [oldOrders, failedJobs] = await Promise.all([
    _db().collection('orders').where('status', '==', 'completed')
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(cutoff)).limit(50).get(),
    _db().collection('asyncJobs').where('status', '==', 'failed')
      .where('retryCount', '<', rule.jobRetryLimit || 3).limit(10).get(),
  ]);

  let archived = 0, retried = 0;

  if (!oldOrders.empty) {
    const batch = _db().batch();
    oldOrders.docs.forEach(doc => {
      batch.set(_db().collection('archivedOrders').doc(doc.id), { ...doc.data(), archivedAt: _ts() });
      batch.delete(doc.ref);
    });
    await batch.commit().catch(() => {});
    archived = oldOrders.size;
  }

  if (!failedJobs.empty) {
    const batch2 = _db().batch();
    failedJobs.docs.forEach(doc => {
      batch2.update(doc.ref, { status: 'pending', retryCount: _inc(1), scheduledAt: _ts() });
    });
    await batch2.commit().catch(() => {});
    retried = failedJobs.size;
  }

  await _logAction({
    action: 'manual_maintenance_trigger',
    trigger: 'admin_action',
    ruleApplied: 'archival',
    entityId: 'on_demand',
    entityType: 'system',
    outcome: 'completed',
    metadata: { archived, retried, triggeredBy: auth.uid },
  });

  return { success: true, archived, retried };
});
