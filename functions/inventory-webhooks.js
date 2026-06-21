/* ═══════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — Developer Webhooks Platform
   Allows external systems to subscribe to inventory events.
   Events: stock.low, fraud.detected, po.created, recall.initiated, etc.
   Signs payloads with HMAC-SHA256 for endpoint verification.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin  = require('firebase-admin');
const https  = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const { assertAuth } = require('./shared/errors');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const CF_OPTS = { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 };

const VALID_EVENTS = [
  'stock.low', 'stock.out', 'stock.adjusted', 'po.created', 'po.approved',
  'po.received', 'movement.recorded', 'fraud.detected', 'recall.initiated',
  'import.completed', 'workflow.triggered', 'health.score.changed',
  'supplier.quotation', 'expiry.near',
];

function _sign(payload, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

async function _dispatch(webhookDoc, event, payload) {
  const wh      = webhookDoc.data();
  if (!wh.active)            return;
  if (!wh.events.includes(event) && !wh.events.includes('*')) return;

  const fullPayload = { event, tenantId: wh.tenantId, data: payload, ts: new Date().toISOString() };
  const signature   = _sign(fullPayload, wh.secret || 'sk_placeholder');

  return new Promise(resolve => {
    try {
      const u = new URL(wh.url);
      const body = JSON.stringify(fullPayload);
      const options = {
        hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'POST',
        headers: {
          'Content-Type'          : 'application/json',
          'Content-Length'        : Buffer.byteLength(body),
          'X-Sokoni-Signature'    : signature,
          'X-Sokoni-Event'        : event,
          'X-Sokoni-Delivery-Id'  : crypto.randomUUID(),
          'User-Agent'            : 'SOKONI-Inventory-Webhooks/2.0',
        },
        ...(u.port ? { port: Number(u.port) } : {}),
      };

      const req = https.request(options, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', async () => {
          const success = res.statusCode >= 200 && res.statusCode < 300;
          /* Log delivery */
          await webhookDoc.ref.collection('deliveries').add({
            event, statusCode: res.statusCode, success,
            deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
          if (!success) {
            await webhookDoc.ref.update({
              failCount: admin.firestore.FieldValue.increment(1),
              lastFailAt: admin.firestore.FieldValue.serverTimestamp(),
            }).catch(() => {});
          }
          resolve({ success, statusCode: res.statusCode });
        });
      });
      req.setTimeout(10_000, () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
      req.on('error', e => resolve({ success: false, error: e.message }));
      req.write(body);
      req.end();
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

/* ── Internal dispatch (called by other modules) ─────────────────── */
async function dispatchWebhookEvent(tenantId, event, payload) {
  if (!VALID_EVENTS.includes(event)) return;
  const snap = await db.collection(`tenants/${tenantId}/inventory_webhooks`)
    .where('active', '==', true).limit(20).get();
  if (snap.empty) return;
  await Promise.all(snap.docs.map(doc => _dispatch(doc, event, payload)));
}
exports.dispatchWebhookEvent = dispatchWebhookEvent;

/* ── Register Webhook ────────────────────────────────────────────── */
exports.inventoryRegisterWebhook = onCall(CF_OPTS, async req => {
  const uid = assertAuth(req);
  const { tenantId, url, events, description } = req.data;
  const resolvedTenant = tenantId || uid;

  /* Validate URL */
  try { new URL(url); } catch { throw new HttpsError('invalid-argument', 'Invalid webhook URL'); }
  /* Validate events */
  const invalidEvents = (events || []).filter(e => e !== '*' && !VALID_EVENTS.includes(e));
  if (invalidEvents.length) throw new Error(`Unknown events: ${invalidEvents.join(', ')}`);

  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  const ref = await db.collection(`tenants/${resolvedTenant}/inventory_webhooks`).add({
    url, events: events || VALID_EVENTS, description: description || '',
    secret, active: true, tenantId: resolvedTenant,
    failCount : 0, deliveryCount: 0,
    createdBy : uid,
    createdAt : admin.firestore.FieldValue.serverTimestamp(),
  });

  return { webhookId: ref.id, secret, message: 'Webhook registered. Keep your secret safe — it will not be shown again.' };
});

/* ── List Webhooks ───────────────────────────────────────────────── */
exports.inventoryListWebhooks = onCall(CF_OPTS, async req => {
  const uid = assertAuth(req);
  const { tenantId } = req.data;
  const resolvedTenant = tenantId || uid;
  const snap = await db.collection(`tenants/${resolvedTenant}/inventory_webhooks`).get();
  return {
    webhooks: snap.docs.map(d => ({
      id: d.id, url: d.data().url, events: d.data().events,
      active: d.data().active, failCount: d.data().failCount,
      createdAt: d.data().createdAt, description: d.data().description,
      /* Never return secret */
    })),
    validEvents: VALID_EVENTS,
  };
});

/* ── Delete Webhook ──────────────────────────────────────────────── */
exports.inventoryDeleteWebhook = onCall(CF_OPTS, async req => {
  const uid = assertAuth(req);
  const { webhookId } = req.data;
  /* Find across tenants owned by this user */
  const snap = await db.collectionGroup('inventory_webhooks')
    .where('createdBy', '==', uid)
    .where(admin.firestore.FieldPath.documentId(), '==', webhookId).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'Webhook not found');
  await snap.docs[0].ref.delete();
  return { webhookId, deleted: true };
});

/* ── Test Webhook ────────────────────────────────────────────────── */
exports.inventoryTestWebhook = onCall(CF_OPTS, async req => {
  const uid = assertAuth(req);
  const { webhookId } = req.data;
  const snap = await db.collectionGroup('inventory_webhooks')
    .where('createdBy', '==', uid).limit(20).get();
  const doc = snap.docs.find(d => d.id === webhookId);
  if (!doc) throw new HttpsError('not-found', 'Webhook not found');
  const result = await _dispatch(doc, 'stock.low', {
    test     : true,
    productId: 'test_product',
    message  : 'This is a test delivery from SOKONI Inventory Webhooks',
  });
  return { webhookId, ...result };
});

/* ── Auto-dispatch: alert created ───────────────────────────────── */
exports.inventoryAlertWebhook = onDocumentCreated(
  { document: 'tenants/{tenantId}/inventory_alerts/{alertId}', ...CF_OPTS },
  async event => {
    const alert    = event.data?.data();
    const tenantId = event.params?.tenantId;
    if (!alert || !tenantId) return;
    const eventMap = {
      stock_low       : 'stock.low',
      stock_out       : 'stock.out',
      fraud_detected  : 'fraud.detected',
      recall_initiated: 'recall.initiated',
      health_drop     : 'health.score.changed',
    };
    const webhookEvent = eventMap[alert.type];
    if (webhookEvent) {
      await dispatchWebhookEvent(tenantId, webhookEvent, alert).catch(err => console.error('Webhook dispatch error:', err.message));
    }
  }
);
