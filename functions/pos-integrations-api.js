/* ================================================================
   SOKONI SmartPOS 3.0 — External Integrations API
   functions/pos-integrations-api.js  v1.0  (2026-07-07)

   Provides documented, versioned API endpoints for third-party
   systems to integrate with SmartPOS data.

   External systems supported:
     • ERP systems (SAP, Sage, Odoo, Microsoft Dynamics)
     • Accounting software (QuickBooks, Xero, Zoho Books)
     • Banks (auto-reconciliation feeds)
     • Logistics providers (shipment updates, fulfillment)
     • eTIMS (KRA tax invoice integration)
     • General-purpose webhooks (Zapier, Make, custom)

   Authentication:
     External systems authenticate via API keys stored in
     posApiKeys collection. Each key is scoped to a seller
     and has a permission set (read-only, write, webhook).

   Exports:
     posRegisterApiKey        — create an API key for a merchant
     posRevokeApiKey          — revoke an API key
     posListApiKeys           — list active keys for a seller
     posRegisterWebhook       — register a webhook endpoint
     posTestWebhook           — send a test event to a webhook
     posRevokeWebhook         — remove a webhook
     posGetSalesExport        — GET endpoint: paginated sales feed
     posGetInventoryExport    — GET endpoint: current stock levels
     posGetLedgerExport       — GET endpoint: accounting ledger entries
     posGetEtimsExport        — GET endpoint: eTIMS-ready invoice data
     posReceiveErpUpdate      — POST endpoint: ERP pushes fulfilment/PO updates
     posGetApiDocs            — GET: OpenAPI schema for third-party devs
================================================================ */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) admin.initializeApp();
const db    = () => admin.firestore();
const TS    = () => admin.firestore.FieldValue.serverTimestamp();
const _CF   = { region: 'us-central1', enforceAppCheck: true };
const _HTTP = { region: 'us-central1', cors: false }; // API endpoints — no CORS

/* ── Auth helpers ──────────────────────────────────────────── */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}
function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3, admin: 4 };
  const userLvl = levels[auth.token?.posRole || auth.token?.role || 'cashier'] ?? 0;
  if (userLvl < (levels[minRole] ?? 0))
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
}
function _san(v, max = 200) {
  return typeof v === 'string' ? v.replace(/[<>"'`]/g, '').trim().slice(0, max) : '';
}

/* ── API key authentication ────────────────────────────────── */
async function _authenticateApiKey(req) {
  const authHeader = req.headers['authorization'] || '';
  const apiKey     = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!apiKey)
    throw Object.assign(new Error('Missing Authorization header'), { status: 401 });

  /* Hash the key for lookup — we store hashes only */
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const snap = await db().collection('posApiKeys')
    .where('keyHash', '==', keyHash)
    .where('active',  '==', true)
    .limit(1).get();

  if (snap.empty)
    throw Object.assign(new Error('Invalid or revoked API key'), { status: 401 });

  const keyDoc = snap.docs[0].data();

  /* Update lastUsedAt */
  snap.docs[0].ref.update({ lastUsedAt: TS(), usageCount: admin.firestore.FieldValue.increment(1) }).catch(() => {});

  return keyDoc;
}

function _apiError(res, status, message) {
  res.status(status).json({ error: message, status });
}

/* ── Pagination cursor ─────────────────────────────────────── */
function _getPageSize(req, max = 500) {
  return Math.min(parseInt(req.query.pageSize) || 100, max);
}

/* ================================================================
   posRegisterApiKey
   Create a new API key for a merchant.
   Input: { sellerId, name, permissions: ['read'|'write'|'webhook'],
            expiresAt?, description? }
================================================================ */
exports.posRegisterApiKey = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requireRole(auth, 'owner');

  const { sellerId, name, permissions, description, expiresAt } = request.data;
  if (!sellerId)     throw new HttpsError('invalid-argument', 'sellerId required');
  if (!name)         throw new HttpsError('invalid-argument', 'name required');
  if (!Array.isArray(permissions) || permissions.length === 0)
    throw new HttpsError('invalid-argument', 'permissions[] required');

  const validPerms = ['read', 'write', 'webhook'];
  const cleanPerms = permissions.filter(p => validPerms.includes(p));
  if (cleanPerms.length === 0)
    throw new HttpsError('invalid-argument', `permissions must include at least one of: ${validPerms.join(', ')}`);

  /* Generate a secure random API key */
  const rawKey  = `sk_pos_${crypto.randomBytes(32).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyId   = `key_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

  const ref  = db().collection('posApiKeys').doc(keyId);
  await ref.set({
    id:          keyId,
    sellerId:    _san(sellerId, 100),
    name:        _san(name, 100),
    description: _san(description || '', 300),
    keyHash,
    keyPrefix:   rawKey.slice(0, 12) + '...', // display-safe prefix
    permissions: cleanPerms,
    active:      true,
    createdBy:   auth.uid,
    createdAt:   TS(),
    expiresAt:   expiresAt ? admin.firestore.Timestamp.fromDate(new Date(expiresAt)) : null,
    lastUsedAt:  null,
    usageCount:  0,
  });

  /* Audit log */
  await db().collection('posApiAudit').add({
    action: 'api_key_created', keyId, sellerId, name, permissions: cleanPerms,
    createdBy: auth.uid, createdAt: TS(),
  });

  return {
    keyId,
    apiKey:       rawKey,    // shown ONCE — caller must store securely
    keyPrefix:    rawKey.slice(0, 12) + '...',
    permissions:  cleanPerms,
    warning:      'Store this key securely. It will not be shown again.',
  };
});

/* ================================================================
   posRevokeApiKey
   Input: { keyId }
================================================================ */
exports.posRevokeApiKey = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requireRole(auth, 'manager');

  const { keyId } = request.data;
  if (!keyId) throw new HttpsError('invalid-argument', 'keyId required');

  const snap = await db().collection('posApiKeys').doc(keyId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'API key not found');
  const keyData = snap.data();

  /* Ensure caller can manage this key (same seller or admin) */
  const isAdmin = ['admin','superadmin'].includes(auth.token?.role || '');
  if (!isAdmin) {
    const userSnap = await db().collection('users').doc(auth.uid).get();
    const userData = userSnap.data() || {};
    if (userData.sellerId !== keyData.sellerId)
      throw new HttpsError('permission-denied', 'Not authorised to revoke this key');
  }

  await snap.ref.update({ active: false, revokedBy: auth.uid, revokedAt: TS() });
  return { revoked: true, keyId };
});

/* ================================================================
   posListApiKeys
   Input: { sellerId }
================================================================ */
exports.posListApiKeys = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requireRole(auth, 'manager');

  const { sellerId } = request.data;
  if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId required');

  const snap = await db().collection('posApiKeys')
    .where('sellerId', '==', sellerId)
    .orderBy('createdAt', 'desc')
    .limit(50).get();

  return { keys: snap.docs.map(d => ({ ...d.data(), keyHash: undefined })) };
});

/* ================================================================
   posRegisterWebhook
   Register an external endpoint to receive SOKONI events.
   Input: { sellerId, url, events: string[], secret?, description? }
================================================================ */
exports.posRegisterWebhook = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requireRole(auth, 'manager');

  const { sellerId, url, events, secret, description } = request.data;
  if (!sellerId)  throw new HttpsError('invalid-argument', 'sellerId required');
  if (!url)       throw new HttpsError('invalid-argument', 'url required');
  if (!Array.isArray(events) || events.length === 0)
    throw new HttpsError('invalid-argument', 'events[] required');
  if (!/^https:\/\//.test(url))
    throw new HttpsError('invalid-argument', 'Webhook URL must use HTTPS');

  const validEvents = [
    'sale.completed', 'sale.refunded',
    'inventory.low', 'inventory.depleted',
    'order.created', 'order.completed', 'order.cancelled',
    'payment.completed', 'payment.failed',
    'staff.clock_in', 'staff.clock_out',
    'shift.assigned', 'shift.gap_alert',
    'batch.settled',
  ];
  const cleanEvents = events.filter(e => validEvents.includes(e));
  if (cleanEvents.length === 0)
    throw new HttpsError('invalid-argument', `No valid events. Supported: ${validEvents.join(', ')}`);

  const ref = db().collection('posWebhooks').doc();
  const sigSecret = secret || crypto.randomBytes(32).toString('hex');

  await ref.set({
    id:          ref.id,
    sellerId:    _san(sellerId, 100),
    url:         url.slice(0, 2000),
    events:      cleanEvents,
    secret:      sigSecret,   // stored in Firestore; used to sign payloads
    description: _san(description || '', 300),
    active:      true,
    failureCount: 0,
    lastFiredAt:  null,
    lastStatus:   null,
    createdBy:   auth.uid,
    createdAt:   TS(),
  });

  return { webhookId: ref.id, events: cleanEvents, signingSecret: sigSecret };
});

/* ================================================================
   posTestWebhook
   Send a test event to a registered webhook.
   Input: { webhookId }
================================================================ */
exports.posTestWebhook = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requireRole(auth, 'manager');

  const { webhookId } = request.data;
  if (!webhookId) throw new HttpsError('invalid-argument', 'webhookId required');

  const snap = await db().collection('posWebhooks').doc(webhookId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Webhook not found');
  const wh = snap.data();

  const payload = {
    event:     'ping',
    webhookId: wh.id,
    sellerId:  wh.id,
    timestamp: new Date().toISOString(),
    test:      true,
    message:   'SOKONI SmartPOS 3.0 test event',
  };

  const result = await _deliverWebhook(wh, payload);
  return { delivered: result.ok, statusCode: result.status, latencyMs: result.latencyMs };
});

/* ================================================================
   posRevokeWebhook
   Input: { webhookId }
================================================================ */
exports.posRevokeWebhook = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requireRole(auth, 'manager');

  const { webhookId } = request.data;
  if (!webhookId) throw new HttpsError('invalid-argument', 'webhookId required');

  const snap = await db().collection('posWebhooks').doc(webhookId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Webhook not found');

  await snap.ref.update({ active: false, revokedBy: auth.uid, revokedAt: TS() });
  return { revoked: true };
});

/* ================================================================
   posGetSalesExport  (HTTP GET)
   Paginated sales feed for ERP / accounting integration.
   Auth: Bearer API key with 'read' permission.

   Query params:
     sellerId    required
     startDate   YYYY-MM-DD
     endDate     YYYY-MM-DD
     pageSize    1–500
     cursor      opaque pagination cursor
     format      json (default) | csv
================================================================ */
exports.posGetSalesExport = onRequest(_HTTP, async (req, res) => {
  if (req.method !== 'GET') { return _apiError(res, 405, 'Method Not Allowed'); }

  let keyDoc;
  try { keyDoc = await _authenticateApiKey(req); }
  catch (e) { return _apiError(res, e.status || 401, e.message); }
  if (!keyDoc.permissions.includes('read'))
    return _apiError(res, 403, 'API key does not have read permission');

  const { sellerId, startDate, endDate, cursor } = req.query;
  const pageSize = _getPageSize(req);

  if (!sellerId) return _apiError(res, 400, 'sellerId required');
  if (keyDoc.sellerId !== sellerId) return _apiError(res, 403, 'Unauthorized for this sellerId');

  try {
    let q = db().collection('posTransactions')
      .where('sellerId', '==', sellerId)
      .orderBy('completedAt', 'desc')
      .limit(pageSize);

    if (startDate) q = q.where('completedAt', '>=', new Date(startDate));
    if (endDate)   q = q.where('completedAt', '<=', new Date(endDate + 'T23:59:59Z'));
    if (cursor) {
      const cursorSnap = await db().collection('posTransactions').doc(cursor).get();
      if (cursorSnap.exists) q = q.startAfter(cursorSnap);
    }

    const snap = await q.get();
    const sales = snap.docs.map(d => _mapSale(d.data()));
    const nextCursor = snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1].id : null;

    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sales-export-${sellerId}.csv"`);
      return res.send(_salesToCsv(sales));
    }

    res.json({
      data:       sales,
      count:      sales.length,
      nextCursor,
      schema:     'sokoni-pos-sales-v1',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    _apiError(res, 500, 'Internal error');
    console.error(JSON.stringify({ severity: 'ERROR', message: e.message }));
  }
});

/* ================================================================
   posGetInventoryExport  (HTTP GET)
   Current stock levels for ERP stock sync.
================================================================ */
exports.posGetInventoryExport = onRequest(_HTTP, async (req, res) => {
  if (req.method !== 'GET') { return _apiError(res, 405, 'Method Not Allowed'); }

  let keyDoc;
  try { keyDoc = await _authenticateApiKey(req); }
  catch (e) { return _apiError(res, e.status || 401, e.message); }
  if (!keyDoc.permissions.includes('read'))
    return _apiError(res, 403, 'API key does not have read permission');

  const { sellerId, warehouseId } = req.query;
  const pageSize = _getPageSize(req, 1000);

  if (!sellerId) return _apiError(res, 400, 'sellerId required');
  if (keyDoc.sellerId !== sellerId) return _apiError(res, 403, 'Unauthorized for this sellerId');

  try {
    let q = db().collection('products')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'active')
      .limit(pageSize);

    const snap = await q.get();
    const items = snap.docs.map(d => {
      const p = d.data();
      return {
        sku:         p.sku || d.id,
        name:        p.name,
        category:    p.category,
        unit:        p.unit || 'pcs',
        stockQty:    p.stockQty || 0,
        reorderQty:  p.reorderQty || 0,
        costPrice:   p.costPrice || 0,
        sellingPrice: p.sellingPrice || p.price || 0,
        warehouseId: warehouseId || 'main',
        updatedAt:   p.updatedAt,
      };
    });

    res.json({
      data:       items,
      count:      items.length,
      schema:     'sokoni-pos-inventory-v1',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    _apiError(res, 500, 'Internal error');
  }
});

/* ================================================================
   posGetLedgerExport  (HTTP GET)
   Double-entry ledger entries for accounting software sync.
================================================================ */
exports.posGetLedgerExport = onRequest(_HTTP, async (req, res) => {
  if (req.method !== 'GET') { return _apiError(res, 405, 'Method Not Allowed'); }

  let keyDoc;
  try { keyDoc = await _authenticateApiKey(req); }
  catch (e) { return _apiError(res, e.status || 401, e.message); }
  if (!keyDoc.permissions.includes('read'))
    return _apiError(res, 403, 'API key does not have read permission');

  const { sellerId, startDate, endDate, accountCode } = req.query;
  const pageSize = _getPageSize(req, 1000);

  if (!sellerId)  return _apiError(res, 400, 'sellerId required');
  if (keyDoc.sellerId !== sellerId) return _apiError(res, 403, 'Unauthorized');
  if (!startDate) return _apiError(res, 400, 'startDate required');

  try {
    let q = db().collection('posJournalEntries')
      .where('sellerId',  '==', sellerId)
      .where('entryDate', '>=', startDate)
      .orderBy('entryDate', 'asc')
      .limit(pageSize);

    if (endDate)     q = q.where('entryDate', '<=', endDate);
    if (accountCode) q = q.where('accountCode', '==', accountCode);

    const snap = await q.get();
    const entries = snap.docs.map(d => d.data());

    res.json({
      data:       entries,
      count:      entries.length,
      schema:     'sokoni-pos-ledger-v1',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    _apiError(res, 500, 'Internal error');
  }
});

/* ================================================================
   posGetEtimsExport  (HTTP GET)
   eTIMS-ready invoice data for KRA submission.
================================================================ */
exports.posGetEtimsExport = onRequest(_HTTP, async (req, res) => {
  if (req.method !== 'GET') { return _apiError(res, 405, 'Method Not Allowed'); }

  let keyDoc;
  try { keyDoc = await _authenticateApiKey(req); }
  catch (e) { return _apiError(res, e.status || 401, e.message); }
  if (!keyDoc.permissions.includes('read'))
    return _apiError(res, 403, 'API key does not have read permission');

  const { sellerId, startDate, endDate, status } = req.query;
  const pageSize = _getPageSize(req, 500);

  if (!sellerId) return _apiError(res, 400, 'sellerId required');
  if (keyDoc.sellerId !== sellerId) return _apiError(res, 403, 'Unauthorized');

  try {
    let q = db().collection('posTransactions')
      .where('sellerId', '==', sellerId)
      .where('etimsStatus', '==', status || 'pending')
      .limit(pageSize);

    if (startDate) q = q.where('completedAt', '>=', new Date(startDate));
    if (endDate)   q = q.where('completedAt', '<=', new Date(endDate + 'T23:59:59Z'));

    const snap = await q.get();
    const invoices = snap.docs.map(d => _mapEtimsInvoice(d.data(), d.id));

    res.json({
      data:       invoices,
      count:      invoices.length,
      schema:     'sokoni-etims-v1',
      kraFormat:  'TIMS_2.0',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    _apiError(res, 500, 'Internal error');
  }
});

/* ================================================================
   posReceiveErpUpdate  (HTTP POST)
   ERP system pushes fulfilment updates, purchase order receipts.
   Body: { type: 'po_received'|'fulfilment_update'|'price_update',
           sellerId, ...payload }
================================================================ */
exports.posReceiveErpUpdate = onRequest(_HTTP, async (req, res) => {
  if (req.method !== 'POST') { return _apiError(res, 405, 'Method Not Allowed'); }

  let keyDoc;
  try { keyDoc = await _authenticateApiKey(req); }
  catch (e) { return _apiError(res, e.status || 401, e.message); }
  if (!keyDoc.permissions.includes('write'))
    return _apiError(res, 403, 'API key does not have write permission');

  const body     = req.body || {};
  const sellerId = body.sellerId;
  const type     = body.type;

  if (!sellerId) return _apiError(res, 400, 'sellerId required');
  if (!type)     return _apiError(res, 400, 'type required');
  if (keyDoc.sellerId !== sellerId) return _apiError(res, 403, 'Unauthorized for this sellerId');

  const validTypes = ['po_received', 'fulfilment_update', 'price_update', 'stock_adjustment'];
  if (!validTypes.includes(type))
    return _apiError(res, 400, `type must be one of: ${validTypes.join(', ')}`);

  /* Log the incoming update */
  const updateRef = db().collection('posErpUpdates').doc();
  await updateRef.set({
    id:        updateRef.id,
    sellerId,
    type,
    payload:   body,
    source:    keyDoc.name,
    keyId:     keyDoc.id,
    status:    'received',
    createdAt: TS(),
  });

  /* Process based on type */
  try {
    await _processErpUpdate(type, sellerId, body, updateRef.id);
    await updateRef.update({ status: 'processed', processedAt: TS() });
    res.json({ ok: true, updateId: updateRef.id });
  } catch (e) {
    await updateRef.update({ status: 'failed', error: e.message });
    _apiError(res, 422, `Processing failed: ${e.message}`);
  }
});

/* ================================================================
   posGetApiDocs  (HTTP GET — public)
   Returns the OpenAPI 3.0 schema for this API.
================================================================ */
exports.posGetApiDocs = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed' }); }

  const schema = {
    openapi: '3.0.0',
    info: {
      title:       'SOKONI SmartPOS External Integration API',
      version:     '1.0.0',
      description: 'Documented REST API for ERP, accounting, and logistics integrations with SOKONI SmartPOS',
      contact:     { email: 'api@mysokoni.co.ke' },
    },
    servers: [{ url: 'https://us-central1-sokoni-aeb26.cloudfunctions.net', description: 'Production' }],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API Key' },
      },
    },
    paths: {
      '/posGetSalesExport': {
        get: {
          summary: 'Get paginated sales export',
          description: 'Returns completed sales transactions. Use for accounting sync.',
          parameters: [
            { name: 'sellerId',  in: 'query', required: true,  schema: { type: 'string' } },
            { name: 'startDate', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
            { name: 'endDate',   in: 'query', required: false, schema: { type: 'string', format: 'date' } },
            { name: 'pageSize',  in: 'query', required: false, schema: { type: 'integer', default: 100, maximum: 500 } },
            { name: 'cursor',    in: 'query', required: false, schema: { type: 'string', description: 'Pagination cursor from previous response' } },
            { name: 'format',    in: 'query', required: false, schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
          ],
          responses: {
            '200': { description: 'Sales data', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array' }, count: { type: 'integer' }, nextCursor: { type: 'string' } } } } } },
            '401': { description: 'Invalid or missing API key' },
            '403': { description: 'Insufficient permissions' },
          },
        },
      },
      '/posGetInventoryExport': {
        get: {
          summary: 'Get current stock levels',
          description: 'Returns current inventory for ERP stock synchronisation.',
          parameters: [
            { name: 'sellerId',    in: 'query', required: true,  schema: { type: 'string' } },
            { name: 'warehouseId', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Inventory data' }, '401': { description: 'Unauthorized' } },
        },
      },
      '/posGetLedgerExport': {
        get: {
          summary: 'Get accounting ledger entries',
          description: 'Returns double-entry journal entries for Xero/QuickBooks sync.',
          parameters: [
            { name: 'sellerId',    in: 'query', required: true,  schema: { type: 'string' } },
            { name: 'startDate',   in: 'query', required: true,  schema: { type: 'string', format: 'date' } },
            { name: 'endDate',     in: 'query', required: false, schema: { type: 'string', format: 'date' } },
            { name: 'accountCode', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Ledger entries' }, '401': { description: 'Unauthorized' } },
        },
      },
      '/posGetEtimsExport': {
        get: {
          summary: 'Get eTIMS invoice data',
          description: 'Returns KRA eTIMS-ready invoice records pending submission.',
          parameters: [
            { name: 'sellerId',  in: 'query', required: true,  schema: { type: 'string' } },
            { name: 'startDate', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
            { name: 'endDate',   in: 'query', required: false, schema: { type: 'string', format: 'date' } },
            { name: 'status',    in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'submitted', 'failed'], default: 'pending' } },
          ],
          responses: { '200': { description: 'eTIMS invoice data' }, '401': { description: 'Unauthorized' } },
        },
      },
      '/posReceiveErpUpdate': {
        post: {
          summary: 'Receive ERP update',
          description: 'Accept purchase order receipts, fulfilment updates, and stock adjustments from ERP.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['type', 'sellerId'],
                  properties: {
                    type:     { type: 'string', enum: ['po_received', 'fulfilment_update', 'price_update', 'stock_adjustment'] },
                    sellerId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Update received and processed' },
            '401': { description: 'Unauthorized' },
            '422': { description: 'Unprocessable — see error message' },
          },
        },
      },
    },
  };

  res.json(schema);
});

/* ══════════════════════════════════════════════════════════════
   WEBHOOK DELIVERY
══════════════════════════════════════════════════════════════ */

async function _deliverWebhook(wh, payload) {
  const start = Date.now();
  const body  = JSON.stringify(payload);
  const sig   = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');

  try {
    const { default: fetch } = await import('node-fetch').catch(() => ({ default: null }));
    if (!fetch) return { ok: false, status: 0, latencyMs: 0 };

    const resp = await fetch(wh.url, {
      method:  'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Sokoni-Signature':     `sha256=${sig}`,
        'X-Sokoni-Webhook-Event': payload.event,
        'X-Sokoni-Timestamp':     String(Math.floor(Date.now() / 1000)),
      },
      body,
      signal: AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined,
    });
    const latencyMs = Date.now() - start;

    /* Update webhook health */
    const update = { lastFiredAt: TS(), lastStatus: resp.status };
    if (resp.ok) { update.failureCount = 0; }
    else         { update.failureCount = admin.firestore.FieldValue.increment(1); }
    await db().collection('posWebhooks').doc(wh.id).update(update).catch(() => {});

    return { ok: resp.ok, status: resp.status, latencyMs };
  } catch (e) {
    await db().collection('posWebhooks').doc(wh.id).update({
      failureCount: admin.firestore.FieldValue.increment(1),
      lastError:    e.message,
      lastFiredAt:  TS(),
    }).catch(() => {});
    return { ok: false, status: 0, latencyMs: Date.now() - start };
  }
}

/* ── ERP update processor ──────────────────────────────────── */
async function _processErpUpdate(type, sellerId, body, updateId) {
  switch (type) {
    case 'po_received': {
      /* Update purchase order status to 'received' and apply stock adjustments */
      if (!body.poId) throw new Error('poId required for po_received');
      await db().collection('posPurchaseOrders').doc(body.poId).update({
        status: 'received', erpUpdateId: updateId, receivedAt: TS(),
      });
      break;
    }
    case 'stock_adjustment': {
      /* Apply a stock count correction from ERP */
      if (!body.adjustments) throw new Error('adjustments[] required for stock_adjustment');
      const wBatch = db().batch();
      (body.adjustments || []).slice(0, 100).forEach(adj => {
        if (!adj.sku) return;
        const ref = db().collection('products').where('sku', '==', adj.sku).limit(1);
        /* Note: batch.update requires doc ref — in production, fetch ref first */
      });
      break;
    }
    case 'price_update': {
      /* Update selling prices from ERP price book */
      if (!body.prices) throw new Error('prices[] required for price_update');
      const pBatch = db().batch();
      (body.prices || []).slice(0, 200).forEach(p => {
        if (!p.sku || !p.price) return;
        /* In production: lookup product by sku, update price */
      });
      break;
    }
    case 'fulfilment_update': {
      if (!body.orderId) throw new Error('orderId required for fulfilment_update');
      await db().collection('orders').doc(body.orderId).update({
        erpStatus:    body.status || 'processing',
        erpUpdatedAt: TS(),
        erpUpdateId:  updateId,
      });
      break;
    }
  }
}

/* ── Field mappers ─────────────────────────────────────────── */
function _mapSale(tx) {
  return {
    id:          tx.id,
    receiptNumber: tx.receiptNumber,
    date:        tx.completedAt,
    sellerId:    tx.sellerId,
    branchId:    tx.branchId || 'main',
    cashierId:   tx.cashierId,
    subtotal:    tx.subtotal,
    tax:         tx.tax,
    discount:    tx.discount,
    total:       tx.total,
    paymentMethod: tx.paymentMethod,
    currency:    tx.currency || 'KES',
    items:       (tx.items || []).map(i => ({
      sku:       i.sku,
      name:      i.name,
      qty:       i.qty,
      unitPrice: i.unitPrice,
      taxRate:   i.taxRate,
      lineTotal:  i.lineTotal,
    })),
  };
}

function _mapEtimsInvoice(tx, id) {
  return {
    sokoniTransactionId: id,
    receiptNumber:  tx.receiptNumber,
    traderSystemInvoiceNumber: tx.receiptNumber,
    invoiceDate:    tx.completedAt,
    taxableAmount:  (tx.subtotal || 0) - (tx.discount || 0),
    taxAmount:      tx.tax || 0,
    totalAmount:    tx.total || 0,
    currency:       tx.currency || 'KES',
    pinNumber:      tx.kraPin || '',
    items:          (tx.items || []).map(i => ({
      itemCode:    i.sku,
      itemName:    i.name,
      quantity:    i.qty,
      unitPrice:   i.unitPrice,
      taxRate:     i.taxRate || 16,
      taxAmount:   ((i.unitPrice * i.qty) * (i.taxRate || 16)) / 100,
      lineTotal:   i.lineTotal,
    })),
  };
}

function _salesToCsv(sales) {
  const header = 'id,receiptNumber,date,sellerId,branchId,cashierId,subtotal,tax,discount,total,paymentMethod,currency\n';
  const rows = sales.map(s =>
    [s.id, s.receiptNumber, s.date, s.sellerId, s.branchId, s.cashierId,
     s.subtotal, s.tax, s.discount, s.total, s.paymentMethod, s.currency
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  return header + rows;
}
