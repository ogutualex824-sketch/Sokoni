'use strict';

/* ================================================================
   SOKONI Webhook Engine v1.0
   functions/webhook-engine.js  |  2026-07-08

   Production webhook delivery system for SOKONI platform integrations.
   Connects any external system to SOKONI platform events via HTTPS
   callbacks with HMAC-SHA256 payload signing.

   Features:
     • HMAC-SHA256 signing on every delivery
     • Automatic exponential-backoff retry (1 min → 5 min → 30 min → 2 h)
     • Dead-letter after 5 consecutive failures per delivery
     • Auto-disable subscription after 10 cumulative failures
     • Soft-delete (delivery history preserved)
     • Paginated delivery history per subscription
     • Platform-wide delivery statistics for admin

   Data model:
     webhookSubscriptions/{subscriptionId}
       url, events[], secret (HMAC key), ownerId, active,
       createdAt, lastDeliveryAt, failureCount,
       autoDisabledAt?, autoDisabledReason?

     webhookDeliveries/{deliveryId}
       subscriptionId, event, payload, status,
       attempts, nextRetryAt, lastAttemptAt,
       responseCode, responseBody, latencyMs,
       createdAt, deliveredAt?, failedAt?

   Exports:
     webhookRegister       — onCall — register an endpoint
     webhookList           — onCall — list caller's subscriptions
     webhookDelete         — onCall — soft-delete a subscription
     webhookDeliver        — onCall — trigger delivery for an event (admin)
     webhookRetryProcessor — onSchedule — process retry queue (every 1 min)
     webhookGetDeliveries  — onCall — delivery history for a subscription
     webhookTestEndpoint   — onCall — send a test ping
     webhookGetStats       — onCall — platform-wide stats (admin)
================================================================ */

const functions      = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin          = require('firebase-admin');
const crypto         = require('crypto');
const https          = require('https');
const { URL }        = require('url');
const { FieldValue } = require('firebase-admin/firestore');

if (!admin.apps.length) admin.initializeApp();

const db     = () => admin.firestore();
const logger = functions.logger;

const _h = {};

/* ── Region ───────────────────────────────────────────────────── */
const REGION = 'us-central1';

/* ── Shared CF options ────────────────────────────────────────── */
const CF_OPTS = {
  region:          REGION,
  timeoutSeconds:  60,
  memory:          '256MiB',
  enforceAppCheck: true,
};

/* ═══════════════════════════════════════════════════════════════
   ALLOWED EVENTS
   Only these event types may be subscribed to.
   Keep in sync with platform-event-bus.js when adding new events.
═══════════════════════════════════════════════════════════════ */
const ALLOWED_EVENTS = [
  'payment.completed',
  'payment.failed',
  'order.created',
  'order.status_changed',
  'delivery.updated',
  'delivery.completed',
  'booking.confirmed',
  'booking.cancelled',
  'ticket.purchased',
  'refund.processed',
  'dispute.opened',
  'dispute.resolved',
];

/* ═══════════════════════════════════════════════════════════════
   RETRY & FAILURE CONSTANTS
   Exponential backoff delays (seconds) for failed deliveries.
   Index = attempt number AFTER the failure (1-based).
     1st failure → retry after RETRY_DELAYS[0] = 60 s  (1 min)
     2nd failure → retry after RETRY_DELAYS[1] = 300 s (5 min)
     3rd failure → retry after RETRY_DELAYS[2] = 1800s (30 min)
     4th failure → retry after RETRY_DELAYS[3] = 7200s (2 h)
     5th failure → delivery dead-lettered (status = 'failed')
═══════════════════════════════════════════════════════════════ */
const MAX_ATTEMPTS          = 5;  // 1 initial + 4 retries
const MAX_SUBSCRIPTION_FAILS = 10; // auto-disable subscription after this many
const DELIVERY_TIMEOUT_MS   = 10_000; // 10 s per attempt
const RETRY_DELAYS_S        = [60, 300, 1800, 7200]; // 4 elements (delays for retries 1-4)

/* ═══════════════════════════════════════════════════════════════
   UTILITY HELPERS
═══════════════════════════════════════════════════════════════ */

function _isAdmin(req) {
  return req.auth?.token?.admin === true || req.auth?.token?.superAdmin === true;
}

function _assertAuth(req) {
  if (!req.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  return req.auth.uid;
}

function _assertAdmin(req) {
  _assertAuth(req);
  if (!_isAdmin(req)) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
  return req.auth.uid;
}

/** Generate a cryptographically random HMAC signing secret. */
function _generateSecret() {
  return 'whsec_' + crypto.randomBytes(32).toString('hex');
}

/** Generate a collision-resistant delivery document ID. */
function _deliveryId() {
  return 'wdel_' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}

/**
 * Compute HMAC-SHA256 signature.
 * The signature is over the exact byte string sent in the POST body.
 * External callers verify: HMAC-SHA256(secret, rawBody) === sig.slice(7)
 */
function _sign(bodyStr, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
}

/**
 * Validate that a URL is publicly accessible HTTPS.
 * Rejects localhost, private IP ranges, and non-HTTPS schemes.
 */
function _validateUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch {
    return { valid: false, error: 'Invalid URL format.' };
  }

  if (u.protocol !== 'https:') {
    return { valid: false, error: 'Webhook URL must use HTTPS.' };
  }

  const host = u.hostname.toLowerCase();
  const privatePatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^::1$/,
    /^fc[0-9a-f]{2}:/i, // IPv6 unique local
  ];
  if (privatePatterns.some(p => p.test(host))) {
    return { valid: false, error: 'Webhook URL must be a publicly accessible HTTPS endpoint. Private/loopback addresses are not allowed.' };
  }

  return { valid: true };
}

/* ═══════════════════════════════════════════════════════════════
   CORE HTTP DELIVERY ENGINE
   Sends one POST attempt to a subscription URL.
   Returns { success, responseCode, responseBody, latencyMs }.
   Never throws — all errors are captured and returned as failure results.
═══════════════════════════════════════════════════════════════ */
async function _sendWebhook(subscription, deliveryId, event, payload) {
  const { url, secret } = subscription;

  /* Build payload body exactly once — used for signing and for the wire */
  const bodyObj = {
    id:        deliveryId,
    event,
    payload:   payload || {},
    timestamp: new Date().toISOString(),
  };
  const bodyStr = JSON.stringify(bodyObj);
  const sig     = _sign(bodyStr, secret);
  const startMs = Date.now();

  return new Promise(resolve => {
    try {
      const u = new URL(url);

      const options = {
        hostname: u.hostname,
        port:     u.port ? Number(u.port) : 443,
        path:     u.pathname + (u.search || ''),
        method:   'POST',
        headers:  {
          'Content-Type':       'application/json',
          'Content-Length':     Buffer.byteLength(bodyStr),
          'X-Sokoni-Signature': sig,
          'X-Sokoni-Event':     event,
          'X-Sokoni-Delivery':  deliveryId,
          'User-Agent':         'SOKONI-Webhooks/1.0',
        },
      };

      const req = https.request(options, httpRes => {
        let raw = '';
        httpRes.setEncoding('utf8');
        httpRes.on('data', chunk => { raw += chunk; });
        httpRes.on('end', () => {
          const responseCode = httpRes.statusCode || 0;
          const success      = responseCode >= 200 && responseCode < 300;
          resolve({
            success,
            responseCode,
            responseBody: raw.slice(0, 1024), // cap at 1 KB
            latencyMs:    Date.now() - startMs,
          });
        });
      });

      req.setTimeout(DELIVERY_TIMEOUT_MS, () => {
        req.destroy();
        resolve({
          success:      false,
          responseCode: 0,
          responseBody: 'timeout',
          latencyMs:    DELIVERY_TIMEOUT_MS,
        });
      });

      req.on('error', err => {
        resolve({
          success:      false,
          responseCode: 0,
          responseBody: err.message.slice(0, 200),
          latencyMs:    Date.now() - startMs,
        });
      });

      req.write(bodyStr);
      req.end();

    } catch (err) {
      resolve({
        success:      false,
        responseCode: 0,
        responseBody: err.message.slice(0, 200),
        latencyMs:    Date.now() - startMs,
      });
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   DELIVERY STATE MACHINE
   Records the outcome of one delivery attempt in Firestore.
   Schedules the next retry (exponential backoff) on failure.
   Auto-disables the subscription after too many cumulative failures.
═══════════════════════════════════════════════════════════════ */
async function _recordDeliveryAttempt(deliveryRef, subRef, result, prevAttempts) {
  const attempts = prevAttempts + 1; // total attempts after this one
  const isDead   = attempts >= MAX_ATTEMPTS;

  const deliveryUpdate = {
    attempts,
    lastAttemptAt: FieldValue.serverTimestamp(),
    responseCode:  result.responseCode,
    responseBody:  result.responseBody,
    latencyMs:     result.latencyMs,
  };

  if (result.success) {
    /* ── Delivered ───────────────────────────────────────────── */
    deliveryUpdate.status      = 'delivered';
    deliveryUpdate.deliveredAt = FieldValue.serverTimestamp();
    deliveryUpdate.nextRetryAt = null;

    await Promise.all([
      deliveryRef.update(deliveryUpdate),
      subRef.update({
        lastDeliveryAt: FieldValue.serverTimestamp(),
        /* Successful delivery resets the failure streak */
        failureCount: 0,
      }),
    ]);

  } else if (isDead) {
    /* ── Dead-lettered ───────────────────────────────────────── */
    deliveryUpdate.status    = 'failed';
    deliveryUpdate.failedAt  = FieldValue.serverTimestamp();
    deliveryUpdate.nextRetryAt = null;

    /* Atomic increment — avoids read-modify-write race on failureCount */
    await Promise.all([
      deliveryRef.update(deliveryUpdate),
      subRef.update({
        failureCount:   FieldValue.increment(1),
        lastDeliveryAt: FieldValue.serverTimestamp(),
      }),
    ]);

    /* Read back the post-increment value to check auto-disable threshold */
    const subSnap  = await subRef.get();
    const newFails = subSnap.exists ? (subSnap.data().failureCount || 0) : 0;

    if (newFails >= MAX_SUBSCRIPTION_FAILS) {
      await subRef.update({
        active:             false,
        autoDisabledAt:     FieldValue.serverTimestamp(),
        autoDisabledReason: `Auto-disabled after ${newFails} cumulative delivery failures. Reactivate and fix your endpoint to resume.`,
      });
      logger.warn('[webhooks] Subscription auto-disabled', {
        subscriptionId: subRef.id,
        failureCount:   newFails,
      });
    }

  } else {
    /* ── Pending retry ───────────────────────────────────────── */
    const delaySec    = RETRY_DELAYS_S[attempts - 1] ?? RETRY_DELAYS_S[RETRY_DELAYS_S.length - 1];
    const nextRetryAt = admin.firestore.Timestamp.fromMillis(Date.now() + delaySec * 1000);

    deliveryUpdate.status      = 'pending';
    deliveryUpdate.nextRetryAt = nextRetryAt;

    await deliveryRef.update(deliveryUpdate);
  }
}

/* ═══════════════════════════════════════════════════════════════
   webhookRegister — onCall (authenticated)
   Register a new webhook endpoint.
   Sends a synchronous ping verification delivery (fire-and-forget).
   Returns { subscriptionId, secret } — secret is shown only once.
═══════════════════════════════════════════════════════════════ */
exports.webhookRegister = onCall(CF_OPTS, _h.webhookRegister = async req => {
  const uid = _assertAuth(req);
  const { url, events, secret: clientSecret } = req.data || {};

  /* Validate URL */
  if (!url || typeof url !== 'string') {
    throw new HttpsError('invalid-argument', '"url" is required.');
  }
  const urlCheck = _validateUrl(url);
  if (!urlCheck.valid) {
    throw new HttpsError('invalid-argument', urlCheck.error);
  }

  /* Validate events array */
  if (!Array.isArray(events) || events.length === 0) {
    throw new HttpsError('invalid-argument',
      '"events" must be a non-empty array. Allowed events: ' + ALLOWED_EVENTS.join(', '));
  }
  const badEvents = events.filter(e => !ALLOWED_EVENTS.includes(e));
  if (badEvents.length > 0) {
    throw new HttpsError('invalid-argument',
      `Unknown events: ${badEvents.join(', ')}. Allowed: ${ALLOWED_EVENTS.join(', ')}`);
  }
  if (events.length > ALLOWED_EVENTS.length) {
    throw new HttpsError('invalid-argument',
      `Maximum ${ALLOWED_EVENTS.length} events per subscription.`);
  }

  /* Enforce per-user subscription limit (prevent abuse) */
  const existingSnap = await db().collection('webhookSubscriptions')
    .where('ownerId', '==', uid)
    .where('active', '==', true)
    .count()
    .get();
  if (existingSnap.data().count >= 20) {
    throw new HttpsError('resource-exhausted',
      'Maximum of 20 active webhook subscriptions per account. Delete existing ones to add new ones.');
  }

  /* Use caller-supplied secret only if it's strong enough; otherwise generate one */
  const secret = (typeof clientSecret === 'string' && clientSecret.length >= 32)
    ? clientSecret
    : _generateSecret();

  /* Create subscription document */
  const subRef = db().collection('webhookSubscriptions').doc();
  await subRef.set({
    url,
    events,
    secret,
    ownerId:       uid,
    active:        true,
    failureCount:  0,
    createdAt:     FieldValue.serverTimestamp(),
    updatedAt:     FieldValue.serverTimestamp(),
    lastDeliveryAt: null,
  });

  /* Send ping verification (fire-and-forget — registration doesn't block on it) */
  const pingId  = _deliveryId();
  const pingRef = db().collection('webhookDeliveries').doc(pingId);

  await pingRef.set({
    subscriptionId: subRef.id,
    event:          'ping',
    payload:        { message: 'SOKONI webhook registration ping.' },
    status:         'pending',
    attempts:       0,
    nextRetryAt:    null,
    lastAttemptAt:  null,
    responseCode:   null,
    responseBody:   null,
    latencyMs:      null,
    createdAt:      FieldValue.serverTimestamp(),
  });

  /* Async ping — don't await */
  _sendWebhook({ url, secret }, pingId, 'ping', { message: 'SOKONI webhook registration ping.' })
    .then(result => _recordDeliveryAttempt(pingRef, subRef, result, 0))
    .catch(err  => logger.error('[webhooks] Ping error on register',
      { subscriptionId: subRef.id, error: err.message }));

  logger.info('[webhooks] Subscription registered', {
    subscriptionId: subRef.id,
    uid,
    url,
    events,
    eventCount: events.length,
  });

  return {
    subscriptionId: subRef.id,
    secret,
    message: 'Webhook registered. Keep your secret safe — it will not be shown again.',
    allowedEvents: ALLOWED_EVENTS,
  };
});

/* ═══════════════════════════════════════════════════════════════
   webhookList — onCall (authenticated)
   Returns all subscriptions owned by the caller, including
   a preview of the most recent delivery for each.
═══════════════════════════════════════════════════════════════ */
exports.webhookList = onCall(CF_OPTS, _h.webhookList = async req => {
  const uid = _assertAuth(req);

  const snap = await db().collection('webhookSubscriptions')
    .where('ownerId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  /* Fetch last delivery per subscription in parallel */
  const subscriptions = await Promise.all(snap.docs.map(async d => {
    const data = d.data();

    let lastDelivery = null;
    try {
      const ldSnap = await db().collection('webhookDeliveries')
        .where('subscriptionId', '==', d.id)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      if (!ldSnap.empty) {
        const ld = ldSnap.docs[0].data();
        lastDelivery = {
          id:           ldSnap.docs[0].id,
          event:        ld.event,
          status:       ld.status,
          responseCode: ld.responseCode,
          attempts:     ld.attempts || 0,
          lastAttemptAt: ld.lastAttemptAt?.toDate()?.toISOString() || null,
        };
      }
    } catch (err) {
      logger.warn('[webhooks] Could not fetch last delivery', { subscriptionId: d.id, error: err.message });
    }

    return {
      id:             d.id,
      url:            data.url,
      events:         data.events || [],
      active:         data.active,
      failureCount:   data.failureCount || 0,
      createdAt:      data.createdAt?.toDate()?.toISOString() || null,
      lastDeliveryAt: data.lastDeliveryAt?.toDate()?.toISOString() || null,
      autoDisabledAt: data.autoDisabledAt?.toDate()?.toISOString() || null,
      autoDisabledReason: data.autoDisabledReason || null,
      lastDelivery,
      /* secret is NEVER returned after registration */
    };
  }));

  return {
    subscriptions,
    total:         subscriptions.length,
    allowedEvents: ALLOWED_EVENTS,
  };
});

/* ═══════════════════════════════════════════════════════════════
   webhookDelete — onCall (authenticated)
   Soft-delete a subscription (marks inactive, preserves history).
   Admins may delete any subscription; users may only delete their own.
═══════════════════════════════════════════════════════════════ */
exports.webhookDelete = onCall(CF_OPTS, _h.webhookDelete = async req => {
  const uid = _assertAuth(req);
  const { subscriptionId } = req.data || {};

  if (!subscriptionId || typeof subscriptionId !== 'string') {
    throw new HttpsError('invalid-argument', '"subscriptionId" is required.');
  }

  const subRef  = db().collection('webhookSubscriptions').doc(subscriptionId);
  const subSnap = await subRef.get();

  if (!subSnap.exists) {
    throw new HttpsError('not-found', 'Webhook subscription not found.');
  }

  const data = subSnap.data();
  if (data.ownerId !== uid && !_isAdmin(req)) {
    throw new HttpsError('permission-denied', 'Access denied — you do not own this subscription.');
  }
  if (!data.active && data.deletedAt) {
    /* Already deleted — idempotent */
    return { subscriptionId, deleted: true, alreadyDeleted: true };
  }

  await subRef.update({
    active:    false,
    deletedAt: FieldValue.serverTimestamp(),
    deletedBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('[webhooks] Subscription soft-deleted', { subscriptionId, by: uid });
  return { subscriptionId, deleted: true };
});

/* ═══════════════════════════════════════════════════════════════
   webhookDeliver — onCall (admin / internal)
   Trigger delivery of a platform event to subscribed endpoints.
   Optionally scoped to a single subscription via targetSubscriptionId.
   Creates a delivery document then calls _sendWebhook for each target.
═══════════════════════════════════════════════════════════════ */
exports.webhookDeliver = onCall(
  { ...CF_OPTS, timeoutSeconds: 120, memory: '512MiB' },
  _h.webhookDeliver = async req => {
    _assertAdmin(req);

    const { event, payload, targetSubscriptionId } = req.data || {};

    if (!event || typeof event !== 'string') {
      throw new HttpsError('invalid-argument', '"event" is required.');
    }
    if (!ALLOWED_EVENTS.includes(event)) {
      throw new HttpsError('invalid-argument',
        `Unknown event "${event}". Allowed: ${ALLOWED_EVENTS.join(', ')}`);
    }

    const firestore = db();
    let subscriptions = [];

    if (targetSubscriptionId) {
      /* Single-target delivery */
      const snap = await firestore.collection('webhookSubscriptions')
        .doc(targetSubscriptionId).get();
      if (!snap.exists) {
        throw new HttpsError('not-found', 'Target subscription not found.');
      }
      const data = snap.data();
      if (data.active && data.events?.includes(event)) {
        subscriptions = [{ id: snap.id, ...data }];
      }
    } else {
      /* Broadcast to all active subscriptions for this event */
      const snap = await firestore.collection('webhookSubscriptions')
        .where('active', '==', true)
        .limit(200)
        .get();
      subscriptions = snap.docs
        .filter(d => d.data().events?.includes(event))
        .map(d => ({ id: d.id, ...d.data() }));
    }

    if (subscriptions.length === 0) {
      return {
        delivered: 0, failed: 0, total: 0,
        message:  'No active subscriptions found for this event.',
      };
    }

    /* Deliver to all targets concurrently */
    const results = await Promise.allSettled(
      subscriptions.map(async sub => {
        const deliveryId  = _deliveryId();
        const deliveryRef = firestore.collection('webhookDeliveries').doc(deliveryId);
        const subRef      = firestore.collection('webhookSubscriptions').doc(sub.id);

        await deliveryRef.set({
          subscriptionId: sub.id,
          event,
          payload:      payload || {},
          status:       'pending',
          attempts:     0,
          nextRetryAt:  null,
          lastAttemptAt: null,
          responseCode: null,
          responseBody: null,
          latencyMs:    null,
          createdAt:    FieldValue.serverTimestamp(),
        });

        const result = await _sendWebhook(sub, deliveryId, event, payload || {});
        await _recordDeliveryAttempt(deliveryRef, subRef, result, 0);

        return {
          subscriptionId: sub.id,
          deliveryId,
          success:        result.success,
          responseCode:   result.responseCode,
          latencyMs:      result.latencyMs,
        };
      })
    );

    const ok      = results.filter(r => r.status === 'fulfilled' && r.value?.success);
    const errored = results.filter(r => r.status !== 'fulfilled' || !r.value?.success);

    logger.info('[webhooks] Batch delivery complete', {
      event,
      total:   subscriptions.length,
      success: ok.length,
      failed:  errored.length,
    });

    return {
      delivered: ok.length,
      failed:    errored.length,
      total:     subscriptions.length,
      results:   results.map(r =>
        r.status === 'fulfilled'
          ? r.value
          : { success: false, error: r.reason?.message || 'Unknown error' }
      ),
    };
  }
);

/* ═══════════════════════════════════════════════════════════════
   webhookRetryProcessor — onSchedule — every 1 minute
   Processes all deliveries in status='pending' with nextRetryAt <= now.
   Capped at 20 per invocation to stay within timeout.
   Failed deliveries that have exhausted all attempts are dead-lettered.
═══════════════════════════════════════════════════════════════ */
exports.webhookRetryProcessor = onSchedule(
  {
    schedule:       'every 1 minutes',
    region:         REGION,
    timeZone:       'Africa/Nairobi',
    memory:         '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    const firestore = db();
    const now       = admin.firestore.Timestamp.now();

    const snap = await firestore.collection('webhookDeliveries')
      .where('status',      '==', 'pending')
      .where('nextRetryAt', '<=', now)
      .orderBy('nextRetryAt', 'asc')
      .limit(20)
      .get();

    if (snap.empty) return;

    logger.info(`[webhooks] Retry processor: processing ${snap.size} deliveries`);

    /* Sequential loop — each delivery is atomically claimed before sending,
       preventing double-delivery when concurrent scheduler invocations
       pick up the same pending documents.                               */
    const results = [];

    for (const deliveryDoc of snap.docs) {
      const delivery = deliveryDoc.data();

      if (!delivery.subscriptionId) {
        /* Orphaned delivery — dead-letter it */
        await deliveryDoc.ref.update({
          status:      'failed',
          failedAt:    FieldValue.serverTimestamp(),
          responseBody: 'No subscriptionId — orphaned delivery.',
        });
        results.push({ status: 'fulfilled', value: { deliveryId: deliveryDoc.id, skipped: true, reason: 'orphaned' } });
        continue;
      }

      /* ── Atomic claim — transition pending → processing ─────── */
      const deliveryRef = deliveryDoc.ref;
      let claimed = false;
      try {
        await firestore.runTransaction(async txn => {
          const fresh = await txn.get(deliveryRef);
          if (!fresh.exists || fresh.data().status !== 'pending') {
            return; // already claimed by another invocation
          }
          txn.update(deliveryRef, {
            status:               'processing',
            processingStartedAt:  admin.firestore.FieldValue.serverTimestamp(),
          });
          claimed = true;
        });
      } catch (e) {
        logger.warn('[wh] claim failed, skipping', { deliveryId: deliveryDoc.id, error: e.message });
        results.push({ status: 'rejected', reason: e });
        continue;
      }
      if (!claimed) {
        results.push({ status: 'fulfilled', value: { deliveryId: deliveryDoc.id, skipped: true, reason: 'already_claimed' } });
        continue;
      }

      /* ── Subscription validity check ───────────────────────── */
      const subRef  = firestore.collection('webhookSubscriptions').doc(delivery.subscriptionId);
      const subSnap = await subRef.get();

      if (!subSnap.exists || !subSnap.data().active) {
        /* Subscription gone or disabled — dead-letter without incrementing failure count */
        await deliveryDoc.ref.update({
          status:      'failed',
          failedAt:    FieldValue.serverTimestamp(),
          responseBody: 'Subscription is inactive or deleted. Delivery aborted.',
        });
        results.push({ status: 'fulfilled', value: { deliveryId: deliveryDoc.id, skipped: true, reason: 'subscription_inactive' } });
        continue;
      }

      /* ── Send and record ────────────────────────────────────── */
      try {
        const sub    = { id: subSnap.id, ...subSnap.data() };
        const result = await _sendWebhook(sub, deliveryDoc.id, delivery.event, delivery.payload || {});
        await _recordDeliveryAttempt(deliveryDoc.ref, subRef, result, delivery.attempts || 0);

        results.push({
          status: 'fulfilled',
          value: {
            deliveryId:     deliveryDoc.id,
            subscriptionId: sub.id,
            success:        result.success,
            responseCode:   result.responseCode,
            latencyMs:      result.latencyMs,
          },
        });
      } catch (e) {
        results.push({ status: 'rejected', reason: e });
      }
    }

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      logger.error(`[webhooks] Retry processor: ${failed.length} internal error(s)`, {
        errors: failed.slice(0, 5).map(r => r.reason?.message),
      });
    }

    const processed = results.filter(r => r.status === 'fulfilled');
    const successes = processed.filter(r => r.value?.success === true);
    logger.info('[webhooks] Retry batch complete', {
      total:   snap.size,
      success: successes.length,
      failed:  failed.length,
    });
  }
);

/* ═══════════════════════════════════════════════════════════════
   webhookGetDeliveries — onCall (authenticated)
   Paginated delivery history for a single subscription.
   Caller must own the subscription (or be admin).
═══════════════════════════════════════════════════════════════ */
exports.webhookGetDeliveries = onCall(CF_OPTS, _h.webhookGetDeliveries = async req => {
  const uid = _assertAuth(req);
  const { subscriptionId, cursor, limit: lim = 25 } = req.data || {};

  if (!subscriptionId || typeof subscriptionId !== 'string') {
    throw new HttpsError('invalid-argument', '"subscriptionId" is required.');
  }

  const firestore = db();
  const subSnap   = await firestore.collection('webhookSubscriptions').doc(subscriptionId).get();

  if (!subSnap.exists) {
    throw new HttpsError('not-found', 'Webhook subscription not found.');
  }
  if (subSnap.data().ownerId !== uid && !_isAdmin(req)) {
    throw new HttpsError('permission-denied', 'Access denied — you do not own this subscription.');
  }

  const pageSize = Math.min(Math.max(1, Number(lim) || 25), 100);

  let query = firestore.collection('webhookDeliveries')
    .where('subscriptionId', '==', subscriptionId)
    .orderBy('createdAt', 'desc')
    .limit(pageSize + 1);

  if (cursor && typeof cursor === 'string') {
    const cursorDoc = await firestore.collection('webhookDeliveries').doc(cursor).get();
    if (cursorDoc.exists) query = query.startAfter(cursorDoc);
  }

  const snap    = await query.get();
  const hasMore = snap.size > pageSize;
  const docs    = snap.docs.slice(0, pageSize).map(d => {
    const data = d.data();
    return {
      id:             d.id,
      event:          data.event,
      status:         data.status,
      attempts:       data.attempts || 0,
      responseCode:   data.responseCode,
      responseBody:   data.responseBody,
      latencyMs:      data.latencyMs,
      createdAt:      data.createdAt?.toDate()?.toISOString()      || null,
      lastAttemptAt:  data.lastAttemptAt?.toDate()?.toISOString()  || null,
      nextRetryAt:    data.nextRetryAt?.toDate()?.toISOString()     || null,
      deliveredAt:    data.deliveredAt?.toDate()?.toISOString()     || null,
      failedAt:       data.failedAt?.toDate()?.toISOString()        || null,
    };
  });

  const subData = subSnap.data();
  return {
    deliveries:    docs,
    hasMore,
    nextCursor:    hasMore ? snap.docs[pageSize - 1].id : null,
    subscription: {
      id:           subSnap.id,
      url:          subData.url,
      events:       subData.events || [],
      active:       subData.active,
      failureCount: subData.failureCount || 0,
    },
  };
});

/* ═══════════════════════════════════════════════════════════════
   webhookTestEndpoint — onCall (authenticated)
   Send a test ping to a subscription's URL without creating a
   permanent delivery record.  Returns live HTTP response details.
═══════════════════════════════════════════════════════════════ */
exports.webhookTestEndpoint = onCall(CF_OPTS, _h.webhookTestEndpoint = async req => {
  const uid = _assertAuth(req);
  const { subscriptionId } = req.data || {};

  if (!subscriptionId || typeof subscriptionId !== 'string') {
    throw new HttpsError('invalid-argument', '"subscriptionId" is required.');
  }

  const subSnap = await db().collection('webhookSubscriptions').doc(subscriptionId).get();
  if (!subSnap.exists) {
    throw new HttpsError('not-found', 'Webhook subscription not found.');
  }
  if (subSnap.data().ownerId !== uid && !_isAdmin(req)) {
    throw new HttpsError('permission-denied', 'Access denied — you do not own this subscription.');
  }

  /* ── Per-user rate limit: max 10 test pings per 60 seconds ── */
  const cooldownRef = db().collection('_webhookTestCooldown').doc(uid);
  const cooldownDoc = await cooldownRef.get();
  if (cooldownDoc.exists) {
    const lastTest = cooldownDoc.data().lastTestAt?.toMillis() || 0;
    const elapsed  = Date.now() - lastTest;
    const count    = cooldownDoc.data().countInWindow || 0;
    if (elapsed < 60_000 && count >= 10) {
      throw new HttpsError('resource-exhausted', 'Test limit: max 10 pings per minute.');
    }
  }
  const withinWindow = cooldownDoc.exists &&
    (Date.now() - (cooldownDoc.data().lastTestAt?.toMillis() || 0)) < 60_000;
  await cooldownRef.set({
    lastTestAt:      FieldValue.serverTimestamp(),
    countInWindow:   FieldValue.increment(1),
    windowStart:     withinWindow
      ? cooldownDoc.data().windowStart
      : FieldValue.serverTimestamp(),
  }, { merge: true });

  const sub    = subSnap.data();
  const testId = 'test_' + crypto.randomBytes(10).toString('hex');

  const result = await _sendWebhook(
    { url: sub.url, secret: sub.secret },
    testId,
    'ping',
    { message: 'SOKONI webhook test' }
  );

  logger.info('[webhooks] Test ping sent', {
    subscriptionId,
    uid,
    success:      result.success,
    responseCode: result.responseCode,
    latencyMs:    result.latencyMs,
  });

  return {
    success:      result.success,
    responseCode: result.responseCode,
    responseBody: result.responseBody,
    latencyMs:    result.latencyMs,
    testId,
  };
});

/* ═══════════════════════════════════════════════════════════════
   webhookGetStats — onCall (admin only)
   Platform-wide webhook delivery statistics.
   Uses Firestore count() for totals (no full collection scans).
═══════════════════════════════════════════════════════════════ */
exports.webhookGetStats = onCall(CF_OPTS, _h.webhookGetStats = async req => {
  _assertAdmin(req);

  const firestore = db();
  const since24h  = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);

  /* ── Aggregate counts via count() (cheap) ─────────────────── */
  const [
    deliveredCount,
    failedCount,
    pendingCount,
    totalSubsCount,
    activeSubsCount,
    disabledSubsCount,
  ] = await Promise.all([
    firestore.collection('webhookDeliveries').where('status', '==', 'delivered').count().get(),
    firestore.collection('webhookDeliveries').where('status', '==', 'failed').count().get(),
    firestore.collection('webhookDeliveries').where('status', '==', 'pending').count().get(),
    firestore.collection('webhookSubscriptions').count().get(),
    firestore.collection('webhookSubscriptions').where('active', '==', true).count().get(),
    firestore.collection('webhookSubscriptions').where('active', '==', false).count().get(),
  ]);

  /* ── Last 24h sample for rates and latency ──────────────────
     Limit to 2000 documents to keep this responsive.
     For a full production analytics pipeline, feed these into
     BigQuery via Firestore export instead.                     */
  const recentSnap = await firestore.collection('webhookDeliveries')
    .where('createdAt', '>=', since24h)
    .orderBy('createdAt', 'desc')
    .limit(2000)
    .get();

  const recent = recentSnap.docs.map(d => d.data());

  /* Delivery outcome counts for the 24h window */
  const delivered24 = recent.filter(d => d.status === 'delivered').length;
  const failed24    = recent.filter(d => d.status === 'failed').length;
  const pending24   = recent.filter(d => d.status === 'pending').length;
  const total24     = recent.length;

  /* Success rate */
  const successRate24 = total24 > 0
    ? Number(((delivered24 / total24) * 100).toFixed(1))
    : 100;

  /* Average delivery latency (delivered only) */
  const latencies    = recent
    .filter(d => d.status === 'delivered' && typeof d.latencyMs === 'number' && d.latencyMs > 0)
    .map(d => d.latencyMs);
  const avgLatencyMs = latencies.length > 0
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : 0;

  /* Top failing subscriptions in the 24h window */
  const failMap = {};
  for (const d of recent.filter(r => r.status === 'failed')) {
    const key = d.subscriptionId || 'unknown';
    failMap[key] = (failMap[key] || 0) + 1;
  }
  const topFailingSubscriptions = Object.entries(failMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([subscriptionId, failCount]) => ({ subscriptionId, failCount }));

  /* Event type breakdown in the 24h window */
  const byEvent = {};
  for (const d of recent) {
    const ev = d.event || 'unknown';
    byEvent[ev] = (byEvent[ev] || 0) + 1;
  }

  return {
    subscriptions: {
      total:    totalSubsCount.data().count,
      active:   activeSubsCount.data().count,
      disabled: disabledSubsCount.data().count,
    },
    deliveries: {
      total:     deliveredCount.data().count + failedCount.data().count + pendingCount.data().count,
      delivered: deliveredCount.data().count,
      failed:    failedCount.data().count,
      pending:   pendingCount.data().count,
    },
    last24h: {
      total:         total24,
      delivered:     delivered24,
      failed:        failed24,
      pending:       pending24,
      successRate:   `${successRate24}%`,
      avgLatencyMs,
      byEvent,
    },
    topFailingSubscriptions,
    retryConfig: {
      maxAttempts:        MAX_ATTEMPTS,
      maxSubscriptionFails: MAX_SUBSCRIPTION_FAILS,
      retryDelaysSeconds:   RETRY_DELAYS_S,
    },
    allowedEvents: ALLOWED_EVENTS,
    generatedAt:   new Date().toISOString(),
  };
});

exports._h = _h;
