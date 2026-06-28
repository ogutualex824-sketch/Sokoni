/* ================================================================
   SOKONI SmartPOS — Integrations, Webhooks & API Layer  v1.0
   Firebase Gen2 Cloud Functions

   Exports — Webhook Management
   ─────────────────────────────
   registerWebhook       onCall  Register external webhook (owner)
   deleteWebhook         onCall  Soft-delete webhook (owner)
   listWebhooks          onCall  List webhooks for seller (manager+)
   testWebhook           onCall  Send test payload to webhook (owner)
   deliverWebhookEvent   onCall  Internal: deliver signed event to webhook URL

   Exports — API Key Management
   ─────────────────────────────
   createAPIKey          onCall  Generate new API key — returned once in plaintext (owner)
   revokeAPIKey          onCall  Deactivate API key (owner)
   listAPIKeys           onCall  List keys metadata — never full key (owner)
   validateAPIKey        onCall  Validate key hash; no AppCheck (external API use)

   Exports — eTIMS Sync
   ─────────────────────
   getPOSSaleForETIMS       onCall  Format POS sale for KRA eTIMS submission
   markSaleSubmittedToETIMS onCall  Mark sale as submitted; store eTIMS ref (manager+)

   Exports — Accounting Export
   ────────────────────────────
   exportToAccountingFormat  onCall  Export to Xero / QuickBooks / CSV format (owner)

   Exports — Bank Reconciliation
   ──────────────────────────────
   importBankStatement       onCall  Match bank transactions against POS records (owner)

   Exports — POS Observability
   ────────────────────────────
   getPOSSystemHealth        onCall  Aggregate health metrics (open sessions, shifts, terminals)
   getPOSAlertHistory        onCall  High-risk audit log events (manager+)

   Security
   ─────────
   • enforceAppCheck on all functions except validateAPIKey
   • Role-based guards: owner, manager, supervisor, cashier
   • Webhook URLs validated (https:// only)
   • API keys stored as SHA-256 hash only — plaintext never persisted
   • Webhook deliveries signed with HMAC-SHA256
   • Failure circuit-breaker: webhook disabled after 5 consecutive failures

   Firestore Collections
   ──────────────────────
   posWebhooks            Registered webhook endpoints
   posAPIKeys             API key metadata (hash only)
   posSales               Sale transactions
   posJournalEntries      Double-entry accounting ledger
   posExpenses            Business expenses
   posShifts              Cashier shift records
   posSessions            Active POS terminal sessions
   posApprovals           Manager approval requests
   posTerminals           Registered POS hardware terminals
   posOfflineQueue        Queued offline transactions
   posAuditLog            Immutable security/ops audit trail
   posWebhookDeliveryLog  Delivery attempt log per webhook
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ── Runtime options ─────────────────────────────────────────────────────── */
const _CF = { region: 'us-central1', enforceAppCheck: true };
/** validateAPIKey is called by external systems without AppCheck context */
const _CF_NOCHECK = { region: 'us-central1', enforceAppCheck: false };

/* ── Constants ───────────────────────────────────────────────────────────── */
const SUPPORTED_EVENTS = [
  'sale.completed',
  'sale.voided',
  'payment.received',
  'inventory.low_stock',
  'customer.created',
  'shift.opened',
  'shift.closed',
  'po.received',
];

const MAX_WEBHOOK_FAILURES = 5;
const WEBHOOK_TIMEOUT_MS   = 10_000;
const API_KEY_PREFIX_LIVE  = 'sk_live_';
const API_KEY_PREFIX_TEST  = 'sk_test_';

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const _TS = () => admin.firestore.FieldValue.serverTimestamp();

function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}

function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3 };
  const userLevel = levels[auth.token?.posRole || 'cashier'] ?? 0;
  const required  = levels[minRole] ?? 0;
  if (userLevel < required)
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
}

function _validateSellerId(sellerId) {
  if (!sellerId || typeof sellerId !== 'string' || !sellerId.trim())
    throw new HttpsError('invalid-argument', 'sellerId is required');
  return sellerId.trim();
}

function _assertSellerAccess(auth, sellerId) {
  if (auth.token?.sellerId && auth.token.sellerId !== sellerId)
    throw new HttpsError('permission-denied', 'Not authorised for this seller account');
}

function _log(severity, msg, extra = {}) {
  console[severity === 'ERROR' ? 'error' : severity === 'WARNING' ? 'warn' : 'log'](
    JSON.stringify({ severity, message: msg, service: 'pos-integrations', ...extra })
  );
}

/**
 * SHA-256 hash of a string. Used for API key storage.
 * @param {string} value
 * @returns {string} hex digest
 */
function _sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * HMAC-SHA256 signature for webhook payloads.
 * @param {string} secret
 * @param {object} payload
 * @returns {string} hex digest
 */
function _hmacSign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

/**
 * Generate a cryptographically secure random hex string.
 * @param {number} bytes
 * @returns {string}
 */
function _randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/* ══════════════════════════════════════════════════════════════════════════
   ███████████  A. WEBHOOK MANAGEMENT  ███████████████████████████████████
══════════════════════════════════════════════════════════════════════════ */

/* ── A1. registerWebhook ───────────────────────────────────────────────── */
exports.registerWebhook = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  _requireRole(auth, 'owner');
  _assertSellerAccess(auth, sellerId);

  const { url, events } = req.data;

  // Validate URL
  if (!url || typeof url !== 'string')
    throw new HttpsError('invalid-argument', 'url is required');
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    throw new HttpsError('invalid-argument', 'url must be a valid URL');
  }
  if (parsedUrl.protocol !== 'https:')
    throw new HttpsError('invalid-argument', 'url must use https://');

  // Validate events
  if (!Array.isArray(events) || events.length === 0)
    throw new HttpsError('invalid-argument', 'events must be a non-empty array');
  const invalidEvents = events.filter(e => !SUPPORTED_EVENTS.includes(e));
  if (invalidEvents.length > 0)
    throw new HttpsError('invalid-argument', `Unsupported events: ${invalidEvents.join(', ')}`);

  // Limit per seller
  const existingSnap = await db.collection('posWebhooks')
    .where('sellerId', '==', sellerId)
    .where('isActive', '==', true)
    .get();
  if (existingSnap.size >= 10)
    throw new HttpsError('resource-exhausted', 'Maximum of 10 active webhooks per seller');

  const secret = _randomHex(32); // 64-char hex secret

  const webhookData = {
    sellerId,
    url,
    events,
    secret,
    isActive:        true,
    failureCount:    0,
    lastTriggeredAt: null,
    createdBy:       auth.uid,
    createdAt:       _TS(),
    updatedAt:       _TS(),
  };

  const ref = await db.collection('posWebhooks').add(webhookData);

  _log('INFO', 'Webhook registered', { sellerId, webhookId: ref.id, events });

  return {
    webhookId: ref.id,
    url,
    events,
    secret, // returned once — caller must store securely
    isActive: true,
  };
});

/* ── A2. deleteWebhook ─────────────────────────────────────────────────── */
exports.deleteWebhook = onCall(_CF, async (req) => {
  const auth      = _requireAuth(req);
  const sellerId  = _validateSellerId(req.data?.sellerId);
  const webhookId = req.data?.webhookId;
  _requireRole(auth, 'owner');
  _assertSellerAccess(auth, sellerId);

  if (!webhookId || typeof webhookId !== 'string')
    throw new HttpsError('invalid-argument', 'webhookId is required');

  const docRef  = db.collection('posWebhooks').doc(webhookId);
  const docSnap = await docRef.get();

  if (!docSnap.exists)
    throw new HttpsError('not-found', 'Webhook not found');
  if (docSnap.data().sellerId !== sellerId)
    throw new HttpsError('permission-denied', 'Webhook does not belong to this seller');

  await docRef.update({ isActive: false, deletedAt: _TS(), deletedBy: auth.uid, updatedAt: _TS() });

  _log('INFO', 'Webhook soft-deleted', { sellerId, webhookId, uid: auth.uid });

  return { webhookId, deleted: true };
});

/* ── A3. listWebhooks ──────────────────────────────────────────────────── */
exports.listWebhooks = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  _requireRole(auth, 'manager');
  _assertSellerAccess(auth, sellerId);

  const snap = await db.collection('posWebhooks')
    .where('sellerId', '==', sellerId)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  const webhooks = snap.docs.map(doc => {
    const { url, events, isActive, failureCount, lastTriggeredAt, createdAt } = doc.data();
    return {
      webhookId:       doc.id,
      url,
      events,
      isActive,
      failureCount,
      lastTriggeredAt: lastTriggeredAt?.toDate?.()?.toISOString() ?? null,
      createdAt:       createdAt?.toDate?.()?.toISOString() ?? null,
      // secret intentionally omitted from list
    };
  });

  return { webhooks, count: webhooks.length };
});

/* ── A4. testWebhook ───────────────────────────────────────────────────── */
exports.testWebhook = onCall(_CF, async (req) => {
  const auth      = _requireAuth(req);
  const sellerId  = _validateSellerId(req.data?.sellerId);
  const webhookId = req.data?.webhookId;
  _requireRole(auth, 'owner');
  _assertSellerAccess(auth, sellerId);

  if (!webhookId || typeof webhookId !== 'string')
    throw new HttpsError('invalid-argument', 'webhookId is required');

  const docRef  = db.collection('posWebhooks').doc(webhookId);
  const docSnap = await docRef.get();

  if (!docSnap.exists)
    throw new HttpsError('not-found', 'Webhook not found');

  const wh = docSnap.data();
  if (wh.sellerId !== sellerId)
    throw new HttpsError('permission-denied', 'Webhook does not belong to this seller');
  if (!wh.isActive)
    throw new HttpsError('failed-precondition', 'Webhook is not active');

  const testPayload = {
    event:     'test',
    webhookId,
    sellerId,
    timestamp: new Date().toISOString(),
    data:      { message: 'This is a test delivery from SOKONI SmartPOS.' },
  };

  const signature = _hmacSign(wh.secret, testPayload);

  const start = Date.now();
  let statusCode = 0;
  let ok = false;

  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    const resp = await fetch(wh.url, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'X-Sokoni-Signature': `sha256=${signature}`,
        'X-Sokoni-Event':     'test',
        'User-Agent':         'SOKONI-Webhooks/1.0',
      },
      body:   JSON.stringify(testPayload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    statusCode = resp.status;
    ok         = resp.ok;
  } catch (err) {
    _log('WARNING', 'Test webhook delivery failed', { webhookId, error: err.message });
    ok = false;
  }

  const responseTime = Date.now() - start;

  _log('INFO', 'Webhook test completed', { webhookId, ok, statusCode, responseTime });

  return { ok, statusCode, responseTime };
});

/* ── A5. deliverWebhookEvent ───────────────────────────────────────────── */
/**
 * Internal Cloud Function: deliver a signed event to a registered webhook URL.
 * Called by other CFs (sale processing, inventory, shift management).
 * Implements circuit-breaker: disables webhook after MAX_WEBHOOK_FAILURES consecutive failures.
 */
exports.deliverWebhookEvent = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  // Internal CF: accept calls from authenticated server-side callers
  // In production, further lock down by verifying a service account claim if needed.

  const { webhookId, eventType, payload } = req.data;

  if (!webhookId || typeof webhookId !== 'string')
    throw new HttpsError('invalid-argument', 'webhookId is required');
  if (!eventType || !SUPPORTED_EVENTS.includes(eventType))
    throw new HttpsError('invalid-argument', `Unsupported eventType: ${eventType}`);
  if (!payload || typeof payload !== 'object')
    throw new HttpsError('invalid-argument', 'payload must be an object');

  const docRef  = db.collection('posWebhooks').doc(webhookId);
  const docSnap = await docRef.get();

  if (!docSnap.exists)
    throw new HttpsError('not-found', 'Webhook not found');

  const wh = docSnap.data();

  if (!wh.isActive)
    return { delivered: false, reason: 'webhook_inactive' };

  if (!wh.events.includes(eventType))
    return { delivered: false, reason: 'event_not_subscribed' };

  const envelope = {
    event:     eventType,
    webhookId,
    sellerId:  wh.sellerId,
    timestamp: new Date().toISOString(),
    data:      payload,
  };

  const signature = _hmacSign(wh.secret, envelope);

  let delivered   = false;
  let statusCode  = 0;
  let errorMsg    = null;
  const startMs   = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    const resp = await fetch(wh.url, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'X-Sokoni-Signature': `sha256=${signature}`,
        'X-Sokoni-Event':     eventType,
        'User-Agent':         'SOKONI-Webhooks/1.0',
      },
      body:   JSON.stringify(envelope),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    statusCode = resp.status;
    delivered  = resp.ok;

    if (!resp.ok) {
      errorMsg = `HTTP ${resp.status}`;
    }
  } catch (err) {
    errorMsg = err.name === 'AbortError' ? 'timeout' : err.message;
    _log('WARNING', 'Webhook delivery failed', { webhookId, eventType, error: errorMsg });
  }

  const responseTimeMs = Date.now() - startMs;

  // Update webhook state atomically
  const updateData = {
    lastTriggeredAt: _TS(),
    updatedAt:       _TS(),
  };

  if (delivered) {
    updateData.failureCount = 0; // reset on success
  } else {
    updateData.failureCount = admin.firestore.FieldValue.increment(1);
    // Circuit-breaker: disable after too many consecutive failures
    const newCount = (wh.failureCount || 0) + 1;
    if (newCount >= MAX_WEBHOOK_FAILURES) {
      updateData.isActive     = false;
      updateData.disabledAt   = _TS();
      updateData.disabledReason = `Disabled after ${MAX_WEBHOOK_FAILURES} consecutive failures`;
      _log('WARNING', 'Webhook disabled (circuit breaker)', { webhookId, failureCount: newCount });
    }
  }

  await docRef.update(updateData);

  // Append delivery log (best-effort)
  await db.collection('posWebhookDeliveryLog').add({
    webhookId,
    sellerId:    wh.sellerId,
    eventType,
    delivered,
    statusCode,
    responseTimeMs,
    errorMsg,
    createdAt:   _TS(),
  }).catch(() => {});

  return { delivered, statusCode, responseTimeMs };
});

/* ══════════════════════════════════════════════════════════════════════════
   ███████████  B. API KEY MANAGEMENT  ████████████████████████████████████
══════════════════════════════════════════════════════════════════════════ */

/* ── B1. createAPIKey ──────────────────────────────────────────────────── */
exports.createAPIKey = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  _requireRole(auth, 'owner');
  _assertSellerAccess(auth, sellerId);

  const { keyName, scopes = [], mode = 'live' } = req.data;

  if (!keyName || typeof keyName !== 'string' || !keyName.trim())
    throw new HttpsError('invalid-argument', 'keyName is required');
  if (!Array.isArray(scopes))
    throw new HttpsError('invalid-argument', 'scopes must be an array');
  if (!['live', 'test'].includes(mode))
    throw new HttpsError('invalid-argument', 'mode must be "live" or "test"');

  // Limit: max 20 active keys per seller
  const existing = await db.collection('posAPIKeys')
    .where('sellerId', '==', sellerId)
    .where('isActive', '==', true)
    .get();
  if (existing.size >= 20)
    throw new HttpsError('resource-exhausted', 'Maximum of 20 active API keys per seller');

  // Generate 40-char random suffix (20 bytes = 40 hex chars)
  const rawSuffix  = _randomHex(20);
  const prefix     = mode === 'live' ? API_KEY_PREFIX_LIVE : API_KEY_PREFIX_TEST;
  const plainKey   = `${prefix}${rawSuffix}`; // e.g. sk_live_<40 hex chars>
  const keyHash    = _sha256(plainKey);
  const keyPrefix  = plainKey.slice(0, 12); // first 12 chars for identification (prefix + first 4 of suffix)

  const keyData = {
    sellerId,
    keyName:    keyName.trim(),
    keyPrefix,
    keyHash,
    scopes,
    mode,
    isActive:   true,
    lastUsedAt: null,
    createdBy:  auth.uid,
    createdAt:  _TS(),
    updatedAt:  _TS(),
  };

  const ref = await db.collection('posAPIKeys').add(keyData);

  _log('INFO', 'API key created', { sellerId, keyId: ref.id, keyPrefix, mode });

  // Return plaintext key ONCE — never stored
  return {
    keyId:    ref.id,
    key:      plainKey, // caller must store this; never retrievable again
    keyPrefix,
    keyName:  keyName.trim(),
    scopes,
    mode,
    warning:  'Store this key immediately. It will not be shown again.',
  };
});

/* ── B2. revokeAPIKey ──────────────────────────────────────────────────── */
exports.revokeAPIKey = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  const keyId    = req.data?.keyId;
  _requireRole(auth, 'owner');
  _assertSellerAccess(auth, sellerId);

  if (!keyId || typeof keyId !== 'string')
    throw new HttpsError('invalid-argument', 'keyId is required');

  const docRef  = db.collection('posAPIKeys').doc(keyId);
  const docSnap = await docRef.get();

  if (!docSnap.exists)
    throw new HttpsError('not-found', 'API key not found');
  if (docSnap.data().sellerId !== sellerId)
    throw new HttpsError('permission-denied', 'Key does not belong to this seller');

  await docRef.update({
    isActive:  false,
    revokedAt: _TS(),
    revokedBy: auth.uid,
    updatedAt: _TS(),
  });

  _log('INFO', 'API key revoked', { sellerId, keyId, uid: auth.uid });

  return { keyId, revoked: true };
});

/* ── B3. listAPIKeys ───────────────────────────────────────────────────── */
exports.listAPIKeys = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  _requireRole(auth, 'owner');
  _assertSellerAccess(auth, sellerId);

  const snap = await db.collection('posAPIKeys')
    .where('sellerId', '==', sellerId)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  const keys = snap.docs.map(doc => {
    const { keyName, keyPrefix, scopes, mode, isActive, lastUsedAt, createdAt } = doc.data();
    return {
      keyId:      doc.id,
      keyName,
      keyPrefix,
      scopes,
      mode,
      isActive,
      lastUsedAt: lastUsedAt?.toDate?.()?.toISOString() ?? null,
      createdAt:  createdAt?.toDate?.()?.toISOString() ?? null,
      // keyHash and full key never returned
    };
  });

  return { keys, count: keys.length };
});

/* ── B4. validateAPIKey ────────────────────────────────────────────────── */
/**
 * Called by external systems (not from browser AppCheck context).
 * Validates an API key by hash lookup, updates lastUsedAt.
 */
exports.validateAPIKey = onCall(_CF_NOCHECK, async (req) => {
  const { apiKey } = req.data;

  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10)
    throw new HttpsError('invalid-argument', 'apiKey is required');

  const keyHash = _sha256(apiKey.trim());

  const snap = await db.collection('posAPIKeys')
    .where('keyHash', '==', keyHash)
    .where('isActive', '==', true)
    .limit(1)
    .get();

  if (snap.empty) {
    _log('WARNING', 'API key validation failed — not found or inactive', {});
    return { valid: false };
  }

  const doc  = snap.docs[0];
  const data = doc.data();

  // Update lastUsedAt (best-effort, non-blocking)
  doc.ref.update({ lastUsedAt: _TS() }).catch(() => {});

  return {
    valid:    true,
    sellerId: data.sellerId,
    scopes:   data.scopes || [],
    mode:     data.mode || 'live',
  };
});

/* ══════════════════════════════════════════════════════════════════════════
   ███████████  C. eTIMS SYNC  ████████████████████████████████████████████
══════════════════════════════════════════════════════════════════════════ */

/* ── C1. getPOSSaleForETIMS ────────────────────────────────────────────── */
exports.getPOSSaleForETIMS = onCall(_CF, async (req) => {
  const auth   = _requireAuth(req);
  const saleId = req.data?.saleId;
  _requireRole(auth, 'manager');

  if (!saleId || typeof saleId !== 'string')
    throw new HttpsError('invalid-argument', 'saleId is required');

  const saleRef  = db.collection('posSales').doc(saleId);
  const saleSnap = await saleRef.get();

  if (!saleSnap.exists)
    throw new HttpsError('not-found', 'Sale not found');

  const sale = saleSnap.data();

  // Access control: manager must belong to same seller
  if (auth.token?.sellerId && auth.token.sellerId !== sale.sellerId)
    throw new HttpsError('permission-denied', 'Not authorised for this sale');

  // Fetch seller profile for KRA PIN
  const sellerSnap = await db.collection('sellers').doc(sale.sellerId).get().catch(() => null);
  const sellerPin  = sellerSnap?.data()?.kraPin || sellerSnap?.data()?.etimsPin || '';

  // Compute VAT
  const VAT_RATE  = 0.16;
  const totalAmount  = sale.totalAmount || 0;
  const vatAmount    = Number((totalAmount * VAT_RATE / (1 + VAT_RATE)).toFixed(2));
  const netAmount    = Number((totalAmount - vatAmount).toFixed(2));

  // Map items to eTIMS format
  const items = (sale.items || []).map(item => ({
    description:  item.name || 'Item',
    quantity:     item.qty  || 1,
    unitPrice:    Number((item.unitPrice || 0).toFixed(2)),
    totalPrice:   Number(((item.unitPrice || 0) * (item.qty || 1)).toFixed(2)),
    vatAmount:    Number((((item.unitPrice || 0) * (item.qty || 1)) * VAT_RATE / (1 + VAT_RATE)).toFixed(2)),
    kraCode:      item.kraCode || item.hsCode || '99999999', // HS code default
    category:     item.category || 'GENERAL',
  }));

  // Payment mode mapping (KRA codes)
  const PAYMENT_MODES = {
    cash:   '01', mpesa: '02', card: '03',
    bank:   '04', credit: '05', other: '99',
  };
  const paymentMode = PAYMENT_MODES[sale.paymentMethod] || PAYMENT_MODES.other;

  const etimsPayload = {
    invoiceNumber:   sale.receiptNumber || sale.invoiceNumber || saleId,
    saleId,
    sellerPin,
    buyerPin:        sale.buyerKraPin || '', // populated if business sale with B2B flag
    buyerName:       sale.customerName || 'Retail Customer',
    saleDate:        sale.createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
    items,
    netAmount,
    vatAmount,
    totalAmount,
    paymentMode,
    currency:        'KES',
    alreadySubmitted: sale.etimsSubmitted || false,
  };

  _log('INFO', 'POS sale formatted for eTIMS', { saleId, sellerId: sale.sellerId });

  return etimsPayload;
});

/* ── C2. markSaleSubmittedToETIMS ──────────────────────────────────────── */
exports.markSaleSubmittedToETIMS = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const saleId   = req.data?.saleId;
  const etimsRef = req.data?.etimsRef;
  _requireRole(auth, 'manager');

  if (!saleId || typeof saleId !== 'string')
    throw new HttpsError('invalid-argument', 'saleId is required');
  if (!etimsRef || typeof etimsRef !== 'string')
    throw new HttpsError('invalid-argument', 'etimsRef is required');

  const saleDocRef  = db.collection('posSales').doc(saleId);
  const saleDocSnap = await saleDocRef.get();

  if (!saleDocSnap.exists)
    throw new HttpsError('not-found', 'Sale not found');

  const sale = saleDocSnap.data();
  if (auth.token?.sellerId && auth.token.sellerId !== sale.sellerId)
    throw new HttpsError('permission-denied', 'Not authorised for this sale');

  if (sale.etimsSubmitted)
    throw new HttpsError('already-exists', 'Sale already marked as submitted to eTIMS');

  await saleDocRef.update({
    etimsSubmitted:   true,
    etimsRef,
    etimsSubmittedAt: _TS(),
    etimsSubmittedBy: auth.uid,
    updatedAt:        _TS(),
  });

  _log('INFO', 'Sale marked as submitted to eTIMS', { saleId, etimsRef, uid: auth.uid });

  return { saleId, etimsRef, submitted: true };
});

/* ══════════════════════════════════════════════════════════════════════════
   ███████████  D. ACCOUNTING EXPORT  █████████████████████████████████████
══════════════════════════════════════════════════════════════════════════ */

/* ── D1. exportToAccountingFormat ──────────────────────────────────────── */
exports.exportToAccountingFormat = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  _requireRole(auth, 'owner');
  _assertSellerAccess(auth, sellerId);

  const { format, startDate, endDate } = req.data;

  if (!['xero', 'quickbooks', 'csv'].includes(format))
    throw new HttpsError('invalid-argument', 'format must be "xero", "quickbooks", or "csv"');

  if (!startDate || !endDate)
    throw new HttpsError('invalid-argument', 'startDate and endDate are required');

  const start = new Date(startDate);
  const end   = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime()))
    throw new HttpsError('invalid-argument', 'startDate and endDate must be valid ISO date strings');

  if (end < start)
    throw new HttpsError('invalid-argument', 'endDate must be after startDate');

  const daysDiff = (end - start) / (1000 * 60 * 60 * 24);
  if (daysDiff > 366)
    throw new HttpsError('invalid-argument', 'Date range must not exceed 1 year');

  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs   = admin.firestore.Timestamp.fromDate(end);

  // Fetch data in parallel
  const [salesSnap, journalSnap, expensesSnap] = await Promise.all([
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .orderBy('createdAt', 'asc')
      .limit(5000)
      .get(),

    db.collection('posJournalEntries')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .orderBy('createdAt', 'asc')
      .limit(10000)
      .get(),

    db.collection('posExpenses')
      .where('sellerId', '==', sellerId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', endTs)
      .orderBy('createdAt', 'asc')
      .limit(2000)
      .get(),
  ]);

  const sales    = salesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const journals = journalSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const expenses = expensesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const formatDate = ts => ts?.toDate?.()?.toISOString?.()?.split('T')[0] || '';

  if (format === 'csv') {
    // Return flat array of rows (sales + expenses combined for ledger)
    const headers = ['Date', 'Type', 'Reference', 'Description', 'Amount (KES)', 'VAT (KES)', 'Payment Method', 'Category'];
    const rows    = [headers];

    for (const s of sales) {
      rows.push([
        formatDate(s.createdAt),
        'SALE',
        s.receiptNumber || s.id,
        `Sale - ${s.items?.length || 0} item(s)`,
        Number(s.totalAmount || 0).toFixed(2),
        Number(s.vatAmount   || 0).toFixed(2),
        s.paymentMethod || 'cash',
        'Revenue',
      ]);
    }

    for (const e of expenses) {
      rows.push([
        formatDate(e.createdAt),
        'EXPENSE',
        e.id,
        e.description || e.category || 'Expense',
        Number(e.amount || 0).toFixed(2),
        Number(e.vatAmount || 0).toFixed(2),
        e.paymentMethod || '',
        e.category || 'Operating',
      ]);
    }

    return { format, rows, count: rows.length - 1 }; // subtract header row
  }

  if (format === 'xero') {
    const invoices = sales.map(s => ({
      Type:          'ACCREC',
      Contact:       { Name: s.customerName || 'Retail Customer' },
      Date:          formatDate(s.createdAt),
      DueDate:       formatDate(s.createdAt),
      InvoiceNumber: s.receiptNumber || s.id,
      Reference:     s.id,
      Status:        'AUTHORISED',
      LineItems:     (s.items || []).map(item => ({
        Description: item.name || 'Item',
        Quantity:    item.qty || 1,
        UnitAmount:  Number(item.unitPrice || 0).toFixed(2),
        AccountCode: '200', // Revenue account
        TaxType:     'OUTPUT2',
      })),
      CurrencyCode: 'KES',
    }));

    const xeroExpenses = expenses.map(e => ({
      Type:          'ACCPAY',
      Contact:       { Name: e.vendorName || e.supplier || 'Supplier' },
      Date:          formatDate(e.createdAt),
      DueDate:       formatDate(e.createdAt),
      Reference:     e.id,
      Status:        'AUTHORISED',
      LineItems:     [{
        Description: e.description || e.category || 'Expense',
        Quantity:    1,
        UnitAmount:  Number(e.amount || 0).toFixed(2),
        AccountCode: '400', // Expenses account
        TaxType:     'INPUT2',
      }],
      CurrencyCode:  'KES',
    }));

    return {
      format,
      xero: {
        Invoices: invoices,
        Bills:    xeroExpenses,
      },
      summary: {
        salesCount:    sales.length,
        expensesCount: expenses.length,
        startDate,
        endDate,
      },
    };
  }

  if (format === 'quickbooks') {
    const qbSales = sales.map(s => ({
      TxnDate:    formatDate(s.createdAt),
      DocNumber:  s.receiptNumber || s.id,
      CustomerRef: { name: s.customerName || 'Retail Customer' },
      TotalAmt:   Number(s.totalAmount || 0).toFixed(2),
      Line: (s.items || []).map(item => ({
        DetailType:      'SalesItemLineDetail',
        Amount:           Number((item.unitPrice || 0) * (item.qty || 1)).toFixed(2),
        SalesItemLineDetail: {
          ItemRef:   { name: item.name || 'Item' },
          Qty:       item.qty || 1,
          UnitPrice: Number(item.unitPrice || 0).toFixed(2),
        },
      })),
      CurrencyRef: { value: 'KES' },
    }));

    const qbExpenses = expenses.map(e => ({
      TxnDate:    formatDate(e.createdAt),
      DocNumber:  e.id,
      TotalAmt:   Number(e.amount || 0).toFixed(2),
      Line: [{
        DetailType:     'AccountBasedExpenseLineDetail',
        Amount:          Number(e.amount || 0).toFixed(2),
        AccountBasedExpenseLineDetail: {
          AccountRef: { name: e.category || 'Operating Expenses' },
        },
        Description: e.description || e.category || 'Expense',
      }],
      CurrencyRef: { value: 'KES' },
    }));

    return {
      format,
      quickbooks: {
        Receipts: qbSales,
        Purchases: qbExpenses,
      },
      summary: {
        salesCount:    sales.length,
        expensesCount: expenses.length,
        startDate,
        endDate,
      },
    };
  }

  // Should never reach here due to validation above
  throw new HttpsError('invalid-argument', 'Unsupported format');
});

/* ══════════════════════════════════════════════════════════════════════════
   ███████████  E. BANK RECONCILIATION  ███████████████████████████████████
══════════════════════════════════════════════════════════════════════════ */

/* ── E1. importBankStatement ───────────────────────────────────────────── */
exports.importBankStatement = onCall(_CF, async (req) => {
  const auth         = _requireAuth(req);
  const sellerId     = _validateSellerId(req.data?.sellerId);
  const transactions = req.data?.transactions;
  _requireRole(auth, 'owner');
  _assertSellerAccess(auth, sellerId);

  if (!Array.isArray(transactions) || transactions.length === 0)
    throw new HttpsError('invalid-argument', 'transactions must be a non-empty array');
  if (transactions.length > 500)
    throw new HttpsError('invalid-argument', 'Maximum 500 transactions per import');

  // Validate transaction shape
  for (const tx of transactions) {
    if (!tx.date || !tx.description || typeof tx.amount !== 'number')
      throw new HttpsError('invalid-argument', 'Each transaction must have date, description, and amount');
  }

  // Build date range from bank transactions
  const dates    = transactions.map(t => new Date(t.date)).filter(d => !isNaN(d));
  const minDate  = new Date(Math.min(...dates));
  const maxDate  = new Date(Math.max(...dates));
  maxDate.setDate(maxDate.getDate() + 1); // inclusive end

  // Fetch POS cash reconciliation records for the same period
  const reconSnap = await db.collection('posCashReconciliation')
    .where('sellerId', '==', sellerId)
    .where('date', '>=', admin.firestore.Timestamp.fromDate(minDate))
    .where('date', '<=', admin.firestore.Timestamp.fromDate(maxDate))
    .limit(1000)
    .get();

  const reconRecords = reconSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const matched   = [];
  const unmatched = [];

  for (const bankTx of transactions) {
    const bankAmount = Math.abs(bankTx.amount);
    const bankDate   = new Date(bankTx.date);

    // Attempt amount match within ±1 KES, ±2 days
    const match = reconRecords.find(r => {
      const reconAmount = Math.abs(r.totalCash || r.amount || 0);
      const reconDate   = r.date?.toDate?.() || new Date(r.date);
      const dateDiffMs  = Math.abs(reconDate - bankDate);
      const dateDiffDays = dateDiffMs / (1000 * 60 * 60 * 24);
      return Math.abs(reconAmount - bankAmount) <= 1 && dateDiffDays <= 2;
    });

    if (match) {
      matched.push({
        bankTx,
        posRecord: {
          id:        match.id,
          amount:    match.totalCash || match.amount || 0,
          date:      match.date?.toDate?.()?.toISOString() || match.date,
          shiftId:   match.shiftId || null,
          branchId:  match.branchId || null,
        },
        confidence: 'high',
      });
    } else {
      // Suggestion: closest amount in same week
      const sameWeek = reconRecords.filter(r => {
        const reconDate = r.date?.toDate?.() || new Date(r.date);
        const diff = Math.abs(reconDate - bankDate) / (1000 * 60 * 60 * 24);
        return diff <= 7;
      });

      const suggestion = sameWeek.sort((a, b) => {
        const diffA = Math.abs(Math.abs(a.totalCash || a.amount || 0) - bankAmount);
        const diffB = Math.abs(Math.abs(b.totalCash || b.amount || 0) - bankAmount);
        return diffA - diffB;
      })[0];

      unmatched.push({
        bankTx,
        suggestion: suggestion
          ? {
              id:       suggestion.id,
              amount:   suggestion.totalCash || suggestion.amount || 0,
              date:     suggestion.date?.toDate?.()?.toISOString() || suggestion.date,
              shiftId:  suggestion.shiftId || null,
            }
          : null,
      });
    }
  }

  _log('INFO', 'Bank statement reconciliation complete', {
    sellerId,
    total:     transactions.length,
    matched:   matched.length,
    unmatched: unmatched.length,
  });

  return {
    matched,
    unmatched,
    summary: {
      total:     transactions.length,
      matched:   matched.length,
      unmatched: unmatched.length,
      matchRate: `${((matched.length / transactions.length) * 100).toFixed(1)}%`,
    },
  };
});

/* ══════════════════════════════════════════════════════════════════════════
   ███████████  F. POS OBSERVABILITY  █████████████████████████████████████
══════════════════════════════════════════════════════════════════════════ */

/* ── F1. getPOSSystemHealth ────────────────────────────────────────────── */
exports.getPOSSystemHealth = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  _requireRole(auth, 'manager');
  _assertSellerAccess(auth, sellerId);

  const now      = new Date();
  const twoMinsAgo = new Date(now.getTime() - 2 * 60 * 1000);

  // Run all health checks in parallel
  const [
    sessionsSnap,
    shiftsSnap,
    approvalsSnap,
    terminalsSnap,
    offlineSnap,
    lowStockSnap,
  ] = await Promise.all([
    // Active POS sessions
    db.collection('posSessions')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'open')
      .get(),

    // Open shifts
    db.collection('posShifts')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'open')
      .get(),

    // Pending approvals
    db.collection('posApprovals')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'pending')
      .get(),

    // Terminal health
    db.collection('posTerminals')
      .where('sellerId', '==', sellerId)
      .get(),

    // Offline queue depth (estimate)
    db.collection('posOfflineQueue')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'pending')
      .limit(200) // cap for cost
      .get()
      .catch(() => ({ size: 0 })), // collection may not exist yet

    // Low stock products
    db.collection('products')
      .where('sellerId', '==', sellerId)
      .where('stockAlert', '==', true)
      .limit(200)
      .get(),
  ]);

  // Assess terminal health
  const terminals         = terminalsSnap.docs.map(d => d.data());
  const degradedTerminals = terminals.filter(t => {
    if (!t.lastPingAt) return true;
    const lastPing = t.lastPingAt.toDate?.() || new Date(t.lastPingAt);
    return (now - lastPing) > 2 * 60 * 1000; // no ping in last 2 minutes
  });

  const terminalHealth = {
    total:    terminals.length,
    online:   terminals.length - degradedTerminals.length,
    degraded: degradedTerminals.length,
    status:   degradedTerminals.length === 0 ? 'ok' : degradedTerminals.length < terminals.length ? 'warning' : 'degraded',
  };

  // Overall health status
  let status = 'ok';
  if (
    approvalsSnap.size > 10 ||
    terminalHealth.status === 'degraded' ||
    (offlineSnap.size || 0) > 50
  ) {
    status = 'degraded';
  } else if (
    approvalsSnap.size > 3 ||
    terminalHealth.status === 'warning' ||
    (offlineSnap.size || 0) > 10 ||
    lowStockSnap.size > 20
  ) {
    status = 'warning';
  }

  return {
    status,
    checkedAt:       now.toISOString(),
    sessions:        sessionsSnap.size,
    openShifts:      shiftsSnap.size,
    pendingApprovals: approvalsSnap.size,
    terminalHealth,
    offlineQueueDepth: offlineSnap.size || 0,
    lowStockCount:   lowStockSnap.size,
  };
});

/* ── F2. getPOSAlertHistory ────────────────────────────────────────────── */
exports.getPOSAlertHistory = onCall(_CF, async (req) => {
  const auth     = _requireAuth(req);
  const sellerId = _validateSellerId(req.data?.sellerId);
  _requireRole(auth, 'manager');
  _assertSellerAccess(auth, sellerId);

  const { startDate, endDate } = req.data;

  const HIGH_RISK_EVENTS = [
    'void',
    'refund',
    'large_discount',
    'cash_variance',
    'shift_discrepancy',
  ];

  let query = db.collection('posAuditLog')
    .where('sellerId', '==', sellerId)
    .where('eventType', 'in', HIGH_RISK_EVENTS);

  if (startDate) {
    const start = new Date(startDate);
    if (!isNaN(start.getTime()))
      query = query.where('createdAt', '>=', admin.firestore.Timestamp.fromDate(start));
  }

  if (endDate) {
    const end = new Date(endDate);
    if (!isNaN(end.getTime()))
      query = query.where('createdAt', '<=', admin.firestore.Timestamp.fromDate(end));
  }

  const snap = await query
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();

  const alerts = snap.docs.map(doc => {
    const { eventType, details, uid, branchId, createdAt } = doc.data();
    return {
      id:        doc.id,
      eventType,
      details:   details || {},
      uid:       uid || null,
      branchId:  branchId || null,
      createdAt: createdAt?.toDate?.()?.toISOString() ?? null,
    };
  });

  // Summary by event type
  const summary = {};
  for (const alert of alerts) {
    summary[alert.eventType] = (summary[alert.eventType] || 0) + 1;
  }

  return {
    alerts,
    count:   alerts.length,
    summary,
  };
});
