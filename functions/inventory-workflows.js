/* ═══════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — Workflow Automation Engine
   No-code automation: triggers, conditions, actions.
   Examples: auto-approve low-value POs, alert on stock-out,
   send WhatsApp when expiry < 30 days, create promotions
   for slow-moving items.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall }            = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const CF_OPTS = { region: 'us-central1', memory: '512MiB', timeoutSeconds: 120 };

/* ── Evaluate conditions ─────────────────────────────────────────── */
function _evalConditions(conditions, context) {
  if (!conditions?.length) return true;
  return conditions.every(c => {
    const val = context[c.field];
    switch (c.operator) {
      case 'eq':  return val == c.value;
      case 'neq': return val != c.value;
      case 'gt':  return Number(val) > Number(c.value);
      case 'gte': return Number(val) >= Number(c.value);
      case 'lt':  return Number(val) < Number(c.value);
      case 'lte': return Number(val) <= Number(c.value);
      case 'contains': return String(val || '').toLowerCase().includes(String(c.value).toLowerCase());
      case 'in':  return (Array.isArray(c.value) ? c.value : [c.value]).includes(val);
      default:    return false;
    }
  });
}

/* ── Execute workflow action ─────────────────────────────────────── */
async function _executeAction(action, context, tenantId) {
  switch (action.type) {
    case 'notify': {
      await db.collection(`tenants/${tenantId}/inventory_alerts`).add({
        type     : 'workflow_notification',
        severity : action.severity || 'INFO',
        title    : _interpolate(action.title, context),
        body     : _interpolate(action.body, context),
        resolved : false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
    }
    case 'create_po': {
      if (context.productId && context.supplierId) {
        await db.collection(`tenants/${tenantId}/inventory_purchaseOrders`).add({
          supplierId  : context.supplierId,
          lineItems   : [{ productId: context.productId, qty: action.qty || context.reorderQty || 10, unit: context.unit || 'pcs' }],
          status      : action.autoApprove ? 'approved' : 'draft',
          totalValue  : (action.qty || 10) * (context.costPrice || 0),
          createdBy   : 'workflow',
          workflowId  : context.workflowId,
          tenantId,
          createdAt   : admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      break;
    }
    case 'alert': {
      await db.collection(`tenants/${tenantId}/inventory_alerts`).add({
        type     : action.alertType || 'workflow_alert',
        severity : action.severity || 'MEDIUM',
        title    : _interpolate(action.title, context),
        body     : _interpolate(action.body || '', context),
        resolved : false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
    }
    case 'email':
    case 'whatsapp': {
      /* Enqueue notification — actual sending handled by email/notification systems */
      await db.collection('notificationQueue').add({
        channel  : action.type,
        to       : _interpolate(action.to, context),
        subject  : _interpolate(action.subject || action.title || '', context),
        body     : _interpolate(action.body || '', context),
        tenantId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
    }
    case 'promotion': {
      if (context.productId) {
        await db.collection(`tenants/${tenantId}/inventory_products`)
          .doc(context.productId)
          .update({ onPromotion: true, promotionDiscount: action.discountPercent || 10 });
      }
      break;
    }
    case 'ai_suggest': {
      /* AI suggestion is handled asynchronously by inventory-ai.js */
      await db.collection(`tenants/${tenantId}/inventory_ai_tasks`).add({
        type: 'reorder_suggestion', productId: context.productId,
        triggeredBy: 'workflow', workflowId: context.workflowId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
    }
    default: break;
  }
}

function _interpolate(template, ctx) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] ?? '');
}

/* ── Run workflow evaluator on alert creation ───────────────────── */
exports.inventoryWorkflowEvaluator = onDocumentCreated(
  { document: 'tenants/{tenantId}/inventory_alerts/{alertId}', ...CF_OPTS },
  async event => {
    const alert    = event.data?.data();
    const tenantId = event.params?.tenantId;
    if (!alert || !tenantId) return;

    /* Load active workflows */
    const wfSnap = await db.collection(`tenants/${tenantId}/inventory_workflows`)
      .where('active', '==', true).limit(50).get();
    if (wfSnap.empty) return;

    const context = { ...alert, tenantId, alertId: event.params.alertId };

    for (const wfDoc of wfSnap.docs) {
      const wf = wfDoc.data();
      if (wf.trigger !== alert.type && wf.trigger !== '*') continue;
      if (!_evalConditions(wf.conditions, context)) continue;

      context.workflowId = wfDoc.id;

      /* Execute all actions */
      const actionResults = [];
      for (const action of (wf.actions || [])) {
        try {
          await _executeAction(action, context, tenantId);
          actionResults.push({ action: action.type, status: 'success' });
        } catch (err) {
          actionResults.push({ action: action.type, status: 'error', error: err.message });
        }
      }

      /* Log run */
      await db.collection(`tenants/${tenantId}/inventory_workflow_runs`).add({
        workflowId : wfDoc.id,
        workflowName: wf.name,
        trigger    : alert.type,
        context    : { alertId: event.params.alertId, type: alert.type },
        results    : actionResults,
        success    : actionResults.every(r => r.status === 'success'),
        ts         : admin.firestore.FieldValue.serverTimestamp(),
      });

      /* Update run count */
      await wfDoc.ref.update({
        runCount: admin.firestore.FieldValue.increment(1),
        lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);

/* ── Workflow run on stock level change ──────────────────────────── */
exports.inventoryWorkflowOnStock = onDocumentUpdated(
  { document: 'tenants/{tenantId}/inventory_levels/{levelId}', ...CF_OPTS },
  async event => {
    const before   = event.data?.before?.data();
    const after    = event.data?.after?.data();
    const tenantId = event.params?.tenantId;
    if (!before || !after || !tenantId) return;

    const productId = after.productId;
    if (!productId) return;

    /* Load product to check reorder point */
    const prodDoc = await db.collection(`tenants/${tenantId}/inventory_products`).doc(productId).get();
    const prod    = prodDoc.exists ? prodDoc.data() : {};
    const rp      = prod.reorderPoint || 5;

    const wasOk      = (before.available || 0) > rp;
    const nowLow     = (after.available  || 0) <= rp && (after.available || 0) > 0;
    const nowOut     = (after.available  || 0) <= 0;
    const trigger    = nowOut ? 'stock.out' : nowLow ? 'stock.low' : null;

    if (!trigger || !wasOk) return;

    const wfSnap = await db.collection(`tenants/${tenantId}/inventory_workflows`)
      .where('active', '==', true)
      .where('trigger', 'in', [trigger, '*']).limit(10).get();

    const context = {
      productId, productName: prod.name, category: prod.category,
      available: after.available, reorderPoint: rp, warehouseId: after.warehouseId,
      supplierId: prod.preferredSupplierId, costPrice: prod.costPrice,
      reorderQty: prod.reorderQty || rp * 3, unit: prod.unit,
    };

    for (const wfDoc of wfSnap.docs) {
      const wf = wfDoc.data();
      if (!_evalConditions(wf.conditions, context)) continue;
      context.workflowId = wfDoc.id;
      for (const action of (wf.actions || [])) {
        await _executeAction(action, context, tenantId).catch(() => {});
      }
      await db.collection(`tenants/${tenantId}/inventory_workflow_runs`).add({
        workflowId: wfDoc.id, trigger, context: { productId, available: after.available },
        ts: admin.firestore.FieldValue.serverTimestamp(), success: true,
      }).catch(() => {});
      await wfDoc.ref.update({ runCount: admin.firestore.FieldValue.increment(1), lastRunAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
  }
);

/* ── CRUD APIs ───────────────────────────────────────────────────── */
exports.inventoryCreateWorkflow = onCall(CF_OPTS, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { tenantId, workflow } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;

  if (!workflow.name || !workflow.trigger || !workflow.actions?.length) {
    throw new Error('Workflow requires name, trigger, and at least one action');
  }

  const ref = await db.collection(`tenants/${resolvedTenant}/inventory_workflows`).add({
    ...workflow,
    tenantId  : resolvedTenant,
    active    : workflow.active !== false,
    runCount  : 0,
    createdBy : req.auth.uid,
    createdAt : admin.firestore.FieldValue.serverTimestamp(),
  });
  return { workflowId: ref.id };
});

exports.inventoryGetWorkflows = onCall({ region: 'us-central1', memory: '256MiB' }, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { tenantId } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;
  const snap = await db.collection(`tenants/${resolvedTenant}/inventory_workflows`).orderBy('createdAt', 'desc').limit(50).get();
  return { workflows: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

exports.inventoryToggleWorkflow = onCall({ region: 'us-central1', memory: '256MiB' }, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { workflowId, active } = req.data;
  const snap = await db.collectionGroup('inventory_workflows')
    .where(admin.firestore.FieldPath.documentId(), '==', workflowId)
    .where('createdBy', '==', req.auth.uid).limit(1).get();
  if (snap.empty) throw new Error('Workflow not found');
  await snap.docs[0].ref.update({ active });
  return { workflowId, active };
});

exports.inventoryDeleteWorkflow = onCall({ region: 'us-central1', memory: '256MiB' }, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { workflowId } = req.data;
  const snap = await db.collectionGroup('inventory_workflows')
    .where(admin.firestore.FieldPath.documentId(), '==', workflowId)
    .where('createdBy', '==', req.auth.uid).limit(1).get();
  if (snap.empty) throw new Error('Workflow not found');
  await snap.docs[0].ref.delete();
  return { workflowId, deleted: true };
});

exports.inventoryGetWorkflowRuns = onCall({ region: 'us-central1', memory: '256MiB' }, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { workflowId, limit = 20, tenantId } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;
  const snap = await db.collection(`tenants/${resolvedTenant}/inventory_workflow_runs`)
    .where('workflowId', '==', workflowId).orderBy('ts', 'desc').limit(limit).get();
  return { runs: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});
