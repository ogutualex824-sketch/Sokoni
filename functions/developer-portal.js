'use strict';

const { onCall }     = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getApps, initializeApp } = require('firebase-admin/app');
const crypto = require('crypto');

if (!getApps().length) initializeApp();
const db = getFirestore();

const REGION = 'us-central1';

const VALID_SCOPES = new Set([
  'orders:read','orders:write','products:read','products:write',
  'payments:read','webhooks:manage','inventory:read','inventory:write','customers:read',
]);
const VALID_EVENTS = new Set([
  'order.created','order.updated','payment.received','payment.failed',
  'product.created','inventory.low_stock','user.registered','review.submitted',
]);

function _auth(req) {
  if (!req.auth) throw new Error('UNAUTHENTICATED');
}
function _limitScopes(scopes) {
  if (!Array.isArray(scopes)) throw new Error('INVALID_ARGUMENT: scopes must be an array');
  for (const s of scopes) {
    if (!VALID_SCOPES.has(s)) throw new Error(`INVALID_ARGUMENT: unknown scope "${s}"`);
  }
}
function _limitEvents(events) {
  if (!Array.isArray(events)) throw new Error('INVALID_ARGUMENT: events must be an array');
  for (const e of events) {
    if (!VALID_EVENTS.has(e)) throw new Error(`INVALID_ARGUMENT: unknown event "${e}"`);
  }
}

// ── 1. generateApiKey ────────────────────────────────────────────────────────
exports.generateApiKey = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { name, environment = 'live', scopes = [] } = req.data || {};
  if (!name || typeof name !== 'string') throw new Error('INVALID_ARGUMENT: name required');
  _limitScopes(scopes);

  const uid = req.auth.uid;
  const raw = `sk_${environment === 'sandbox' ? 'test' : 'live'}_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const keyId   = db.collection('apiKeys').doc().id;

  await db.collection('apiKeys').doc(uid).collection('keys').doc(keyId).set({
    keyId,
    name,
    environment,
    scopes,
    keyHash,
    keySuffix: raw.slice(-4),
    status:    'active',
    createdAt: Timestamp.now(),
    lastUsed:  null,
    callCount: 0,
    createdBy: uid,
  });

  // Return full key ONCE — never stored in plain text
  return { keyId, key: raw, name, environment, scopes };
});

// ── 2. revokeApiKey ──────────────────────────────────────────────────────────
exports.revokeApiKey = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { keyId } = req.data || {};
  if (!keyId) throw new Error('INVALID_ARGUMENT: keyId required');
  const uid = req.auth.uid;

  const ref = db.collection('apiKeys').doc(uid).collection('keys').doc(keyId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('NOT_FOUND: key not found');
  if (snap.data().createdBy !== uid) throw new Error('PERMISSION_DENIED');

  await ref.update({ status: 'revoked', revokedAt: Timestamp.now() });
  return { revoked: true };
});

// ── 3. listApiKeys ───────────────────────────────────────────────────────────
exports.listApiKeys = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const uid = req.auth.uid;
  const snap = await db.collection('apiKeys').doc(uid).collection('keys')
    .orderBy('createdAt', 'desc').limit(20).get();
  return snap.docs.map(d => {
    const k = d.data();
    return {
      keyId: k.keyId, name: k.name, environment: k.environment,
      scopes: k.scopes, keySuffix: k.keySuffix, status: k.status,
      createdAt: k.createdAt?.toMillis(), lastUsed: k.lastUsed?.toMillis(),
      callCount: k.callCount || 0,
    };
  });
});

// ── 4. registerWebhook ───────────────────────────────────────────────────────
exports.registerWebhook = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { url, events = [], description = '' } = req.data || {};

  if (!url || typeof url !== 'string') throw new Error('INVALID_ARGUMENT: url required');
  if (!url.startsWith('https://')) throw new Error('INVALID_ARGUMENT: url must start with https://');
  _limitEvents(events);

  const uid    = req.auth.uid;
  const secret = crypto.randomBytes(32).toString('hex');
  const hookId = db.collection('webhooks').doc().id;

  await db.collection('webhooks').doc(uid).collection('endpoints').doc(hookId).set({
    hookId, url, events, description,
    secretHint: secret.slice(-6), // for display only
    secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
    status:     'active',
    createdAt:  Timestamp.now(),
    createdBy:  uid,
    successCount: 0,
    failCount:    0,
    lastFiredAt:  null,
  });

  return { hookId, url, events, secret }; // secret returned once
});

// ── 5. testWebhook ───────────────────────────────────────────────────────────
exports.testWebhook = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { hookId } = req.data || {};
  if (!hookId) throw new Error('INVALID_ARGUMENT: hookId required');
  const uid = req.auth.uid;

  const snap = await db.collection('webhooks').doc(uid).collection('endpoints').doc(hookId).get();
  if (!snap.exists) throw new Error('NOT_FOUND: webhook not found');
  const hook = snap.data();

  const payload = {
    event:   'webhook.test',
    hookId,
    ts:      Date.now(),
    data:    { message: 'This is a test delivery from SOKONI.' },
  };

  const startMs = Date.now();
  let statusCode = 0, responseMs = 0, error = null;

  try {
    const https = require('https');
    const body  = JSON.stringify(payload);
    const parsedUrl = new URL(hook.url);

    await new Promise((resolve, reject) => {
      const opts = {
        hostname: parsedUrl.hostname, port: 443,
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Sokoni-Event': 'webhook.test',
          'X-Sokoni-Delivery': hookId,
        },
        timeout: 10000,
      };
      const r = https.request(opts, res => {
        statusCode = res.statusCode;
        res.resume();
        resolve();
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
      r.write(body);
      r.end();
    });
    responseMs = Date.now() - startMs;
  } catch (e) {
    error = e.message;
    responseMs = Date.now() - startMs;
  }

  // Log delivery attempt
  await db.collection('webhooks').doc(uid).collection('endpoints').doc(hookId)
    .collection('deliveries').add({
      event: 'webhook.test', payload, statusCode, responseMs,
      error, ts: Timestamp.now(), success: statusCode >= 200 && statusCode < 300,
    });

  return { hookId, url: hook.url, statusCode, responseMs, error, success: !error && statusCode >= 200 && statusCode < 300 };
});

// ── 6. listWebhooks ──────────────────────────────────────────────────────────
exports.listWebhooks = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const uid = req.auth.uid;
  const snap = await db.collection('webhooks').doc(uid).collection('endpoints')
    .orderBy('createdAt', 'desc').limit(20).get();
  return snap.docs.map(d => {
    const h = d.data();
    return {
      hookId: h.hookId, url: h.url, events: h.events, description: h.description,
      status: h.status, successCount: h.successCount, failCount: h.failCount,
      createdAt: h.createdAt?.toMillis(), lastFiredAt: h.lastFiredAt?.toMillis(),
    };
  });
});

// ── 7. deleteWebhook ─────────────────────────────────────────────────────────
exports.deleteWebhook = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { hookId } = req.data || {};
  if (!hookId) throw new Error('INVALID_ARGUMENT: hookId required');
  const uid = req.auth.uid;

  const ref = db.collection('webhooks').doc(uid).collection('endpoints').doc(hookId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('NOT_FOUND');
  if (snap.data().createdBy !== uid) throw new Error('PERMISSION_DENIED');

  await ref.update({ status: 'deleted', deletedAt: Timestamp.now() });
  return { deleted: true };
});

// ── 8. getApiUsage ───────────────────────────────────────────────────────────
exports.getApiUsage = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { days = 30 } = req.data || {};
  const uid  = req.auth.uid;
  const from = Timestamp.fromMillis(Date.now() - days * 24 * 3600 * 1000);

  const snap = await db.collection('apiUsageLogs')
    .where('uid', '==', uid)
    .where('date', '>=', from)
    .orderBy('date', 'desc')
    .limit(200)
    .get();

  const daily = {}, endpoints = {}, errors = { 400: 0, 401: 0, 403: 0, 429: 0, 500: 0 };
  let total = 0;

  snap.docs.forEach(d => {
    const row = d.data();
    const dateKey = row.date?.toDate().toISOString().slice(0, 10) || 'unknown';
    daily[dateKey] = (daily[dateKey] || 0) + (row.calls || 1);
    if (row.endpoint) endpoints[row.endpoint] = (endpoints[row.endpoint] || 0) + 1;
    const code = String(row.statusCode || 200);
    if (errors[code] !== undefined) errors[code]++;
    total++;
  });

  const topEndpoints = Object.entries(endpoints)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([endpoint, calls]) => ({ endpoint, calls }));

  return { total, daily, topEndpoints, errors };
});
