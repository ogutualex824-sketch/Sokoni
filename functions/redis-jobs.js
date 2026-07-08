'use strict';
/**
 * SOKONI Redis Job Handlers
 * functions/redis-jobs.js  v1.0  (2026-07-06)
 *
 * Provides concrete job handlers for every queue managed by QueueService.
 * Imported by the scheduled queue worker in redis-layer.js.
 *
 * Queues:
 *   email        → SendGrid transactional email
 *   notification → Firebase Cloud Messaging push
 *   sms          → Africa's Talking SMS
 *   receipt      → PDF/ESC-POS receipt generation stub
 *   ai           → Claude AI background processing
 *   report       → Firestore aggregation reports
 *   bulk         → Batch Firestore writes
 *   image        → Image resize/compress stub
 */

const admin     = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');

const SENDGRID_API_KEY  = defineSecret('SENDGRID_API_KEY');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const sokoniAt          = require('./sokoni-at');

const R = require('./redis-service');

const db = () => admin.firestore();
const TS = () => admin.firestore.Timestamp.now();

/* Maximum retry count before a job is moved to dead-letter */
const MAX_RETRIES = 3;

/* ── Logger ──────────────────────────────────────────────────── */
function _log(sev, msg, extra = {}) {
  console[sev === 'ERROR' ? 'error' : 'log'](
    JSON.stringify({ severity: sev, message: `[redis-jobs] ${msg}`, ...extra })
  );
}

/* ── Dead-letter store ───────────────────────────────────────── */
async function _deadLetter(queue, job, reason) {
  try {
    await db().collection('redisJobDeadLetter').add({
      queue, job, reason,
      failedAt: TS(),
    });
  } catch {}
  _log('ERROR', `Dead-lettered job`, { queue, jobId: job._id, reason });
}

/* ── Audit trail ─────────────────────────────────────────────── */
async function _audit(queue, jobId, status, meta = {}) {
  try {
    await db().collection('redisJobAudit').add({
      queue, jobId, status, ...meta, ts: TS(),
    });
  } catch {}
}

/* ════════════════════════════════════════════════════════════════
   EMAIL HANDLER  (SendGrid)
   Job shape:
     { to, subject, html?, text?, templateId?, dynamicTemplateData?,
       from?, replyTo?, _retries? }
════════════════════════════════════════════════════════════════ */
async function handleEmail(job) {
  const apiKey = SENDGRID_API_KEY.value();
  if (!apiKey) { _log('ERROR', 'SENDGRID_API_KEY not set'); throw new Error('SendGrid not configured'); }

  const payload = {
    personalizations: [{ to: [{ email: job.to }], dynamic_template_data: job.dynamicTemplateData || {} }],
    from: { email: job.from || 'hello@mysokoni.co.ke', name: job.fromName || 'SOKONI' },
    subject: job.subject,
    ...(job.templateId ? { template_id: job.templateId } : {}),
    ...(job.html  ? { content: [{ type: 'text/html',  value: job.html  }] } : {}),
    ...(job.text  ? { content: [{ type: 'text/plain', value: job.text  }] } : {}),
  };
  if (job.replyTo) payload.reply_to = { email: job.replyTo };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok && res.status !== 202) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendGrid ${res.status}: ${body.slice(0, 200)}`);
  }

  _log('INFO', 'Email sent', { to: job.to, subject: job.subject, jobId: job._id });
}

/* ════════════════════════════════════════════════════════════════
   NOTIFICATION HANDLER  (Firebase Cloud Messaging)
   Job shape:
     { uid?, token?, topic?, title, body, data?, imageUrl?,
       link?, badge?, _retries? }
════════════════════════════════════════════════════════════════ */
async function handleNotification(job) {
  let targets = [];

  if (job.token) {
    targets = [{ type: 'token', value: job.token }];
  } else if (job.topic) {
    targets = [{ type: 'topic', value: job.topic }];
  } else if (job.uid) {
    /* Look up all FCM tokens for this user */
    const snap = await db().collection('users').doc(job.uid)
      .collection('fcmTokens').where('active', '==', true).limit(5).get();
    targets = snap.docs.map(d => ({ type: 'token', value: d.id }));
  }

  if (!targets.length) {
    _log('INFO', 'Notification skipped — no targets', { jobId: job._id });
    return;
  }

  const msgBase = {
    notification: { title: job.title, body: job.body },
    data:    job.data || {},
    android: { notification: { channelId: 'sokoni_default', sound: 'default' } },
    apns:    { payload: { aps: { sound: 'default', badge: job.badge || 0 } } },
    webpush: job.link ? { fcmOptions: { link: job.link } } : undefined,
  };
  if (job.imageUrl) msgBase.notification.image = job.imageUrl;

  let sent = 0;
  for (const target of targets) {
    try {
      if (target.type === 'topic') {
        await admin.messaging().send({ ...msgBase, topic: target.value });
      } else {
        await admin.messaging().send({ ...msgBase, token: target.value });
      }
      sent++;
    } catch (err) {
      /* Remove invalid tokens */
      if (err.code === 'messaging/registration-token-not-registered' && job.uid) {
        await db().collection('users').doc(job.uid)
          .collection('fcmTokens').doc(target.value).update({ active: false }).catch(() => {});
      }
      _log('ERROR', 'FCM send failed', { target: target.value, error: err.message });
    }
  }

  _log('INFO', `Notifications sent: ${sent}/${targets.length}`, { jobId: job._id, uid: job.uid });
}

/* ════════════════════════════════════════════════════════════════
   SMS HANDLER  (Africa's Talking)
   Job shape:
     { to, message, from?, _retries? }
   `to` may be a single phone string or an array (max 20)
════════════════════════════════════════════════════════════════ */
async function handleSMS(job) {
  const to = Array.isArray(job.to) ? job.to.slice(0, 20) : String(job.to);
  await sokoniAt.atSendSMS(to, job.message, job.from || undefined);
  _log('INFO', 'SMS job dispatched', { jobId: job._id });
}

/* ════════════════════════════════════════════════════════════════
   RECEIPT HANDLER
   Job shape:
     { orderId, shopId, format ('pdf'|'escpos'|'both'), _retries? }
   Stores completed receipt URL in Firestore + Redis cache
════════════════════════════════════════════════════════════════ */
async function handleReceipt(job) {
  const { orderId, shopId } = job;
  if (!orderId) throw new Error('orderId required for receipt job');

  /* Fetch order data */
  const orderSnap = await db().collection('orders').doc(orderId).get();
  if (!orderSnap.exists) { _log('INFO', 'Receipt skipped — order not found', { orderId }); return; }
  const order = orderSnap.data();

  /* Mark receipt generation in progress */
  await db().collection('orders').doc(orderId).update({
    'receipt.status':    'generating',
    'receipt.updatedAt': TS(),
  });

  /* Cache a receipt-ready signal in Redis so POS can poll */
  await R.CacheService.set(`receipt:${orderId}`, {
    status: 'ready',
    orderId,
    shopId: shopId || order.shopId,
    generatedAt: Date.now(),
  }, 3600);

  /* Publish event to receipts stream */
  await R.EventBusService.publish('receipts', {
    type: 'receipt_ready',
    orderId, shopId: shopId || order.shopId,
    amount: order.totalAmount,
    currency: order.currency || 'KES',
  });

  /* Update Firestore */
  await db().collection('orders').doc(orderId).update({
    'receipt.status':    'ready',
    'receipt.updatedAt': TS(),
  });

  _log('INFO', 'Receipt queued', { orderId, jobId: job._id });
}

/* ════════════════════════════════════════════════════════════════
   AI HANDLER  (Claude)
   Job shape:
     { prompt, model?, maxTokens?, contextId?, cacheKey?, _retries? }
   Response stored in Redis cache + Firestore aiJobs collection
════════════════════════════════════════════════════════════════ */
async function handleAI(job) {
  const apiKey = ANTHROPIC_API_KEY.value();
  if (!apiKey) { _log('ERROR', 'ANTHROPIC_API_KEY not set'); throw new Error('AI not configured'); }

  /* Check cache first to avoid redundant API calls */
  if (job.cacheKey) {
    const cached = await R.CacheService.aiGet(job.cacheKey);
    if (cached) {
      _log('INFO', 'AI job served from cache', { jobId: job._id, cacheKey: job.cacheKey });
      return cached;
    }
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: job.model || 'claude-haiku-4-5-20251001',
      max_tokens: job.maxTokens || 512,
      messages: [{ role: 'user', content: job.prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  /* Cache with PII redaction */
  if (job.cacheKey && text) {
    await R.CacheService.aiSet(job.cacheKey, R.redactForCache(text));
  }

  /* Persist result to Firestore if contextId given */
  if (job.contextId) {
    await db().collection('aiJobs').doc(job.contextId).set({
      prompt: job.prompt, response: text, model: data.model,
      completedAt: TS(), jobId: job._id,
    }, { merge: true });
  }

  /* Publish to AI event stream */
  await R.EventBusService.publish('ai', {
    type: 'ai_completed', contextId: job.contextId, jobId: job._id,
    model: data.model,
  });

  _log('INFO', 'AI job processed', { jobId: job._id, tokens: data.usage?.output_tokens });
  return text;
}

/* ════════════════════════════════════════════════════════════════
   REPORT HANDLER  (Firestore aggregations)
   Job shape:
     { reportType, shopId, dateFrom?, dateTo?, _retries? }
   reportType: 'daily_sales' | 'inventory_valuation' | 'commission_summary'
════════════════════════════════════════════════════════════════ */
async function handleReport(job) {
  const { reportType, shopId } = job;
  const today = new Date().toISOString().slice(0, 10);
  const refPath = `merchants/${shopId}/reports/${today}_${reportType}`;

  _log('INFO', `Report generation: ${reportType}`, { shopId, jobId: job._id });

  if (reportType === 'daily_sales') {
    const start = admin.firestore.Timestamp.fromDate(new Date(today + 'T00:00:00Z'));
    const end   = admin.firestore.Timestamp.fromDate(new Date(today + 'T23:59:59Z'));
    const snap  = await db().collection('orders')
      .where('shopId',      '==', shopId)
      .where('status',      '==', 'completed')
      .where('completedAt', '>=', start)
      .where('completedAt', '<=', end)
      .get();

    let revenue = 0, orderCount = 0, itemCount = 0;
    snap.forEach(d => {
      const o = d.data();
      revenue += o.totalAmount || 0;
      orderCount++;
      itemCount += (o.items?.length || 0);
    });

    const report = { reportType, shopId, date: today, revenue, orderCount, itemCount, generatedAt: TS() };
    await db().doc(refPath).set(report, { merge: true });

    /* Push to Redis dashboard */
    await R.DashboardService.set(shopId, {
      revenue_today: revenue, orders_today: orderCount, items_sold_today: itemCount,
    }, 3600);

    _log('INFO', `Daily sales report: ${orderCount} orders, KES ${revenue}`, { shopId });
  }

  else if (reportType === 'commission_summary') {
    const snap = await db().collection('ledger')
      .where('merchantId', '==', shopId)
      .where('type',       '==', 'commission')
      .where('createdAt',  '>=', admin.firestore.Timestamp.fromDate(new Date(today + 'T00:00:00Z')))
      .get();

    let total = 0;
    snap.forEach(d => { total += d.data().amount || 0; });
    await db().doc(refPath).set({ reportType, shopId, date: today, commission: total, generatedAt: TS() }, { merge: true });
    _log('INFO', `Commission report: KES ${total}`, { shopId });
  }

  await R.EventBusService.publish('reports', {
    type: 'report_ready', reportType, shopId, date: today, jobId: job._id,
  });
}

/* ════════════════════════════════════════════════════════════════
   BULK IMPORT HANDLER  (Firestore batch writes)
   Job shape:
     { collection, items: [{id?, data}][], batchSize?, _retries? }
════════════════════════════════════════════════════════════════ */
async function handleBulk(job) {
  const { collection: col, items, batchSize = 400 } = job;
  if (!col || !Array.isArray(items) || !items.length) return;

  const SAFE_LIMIT = Math.min(Number(batchSize) || 400, 500);
  let written = 0;

  for (let i = 0; i < items.length; i += SAFE_LIMIT) {
    const slice = items.slice(i, i + SAFE_LIMIT);
    const batch = db().batch();
    for (const item of slice) {
      const ref = item.id
        ? db().collection(col).doc(item.id)
        : db().collection(col).doc();
      batch.set(ref, { ...item.data, _bulkImportedAt: TS() }, { merge: true });
    }
    await batch.commit();
    written += slice.length;
  }

  _log('INFO', `Bulk import complete`, { collection: col, count: written, jobId: job._id });
}

/* ════════════════════════════════════════════════════════════════
   IMAGE HANDLER  (stub — integrate Cloud Storage + Sharp)
   Job shape: { storagePath, sizes?, quality?, _retries? }
════════════════════════════════════════════════════════════════ */
async function handleImage(job) {
  /* Placeholder: actual implementation would use Cloud Storage triggers
     or a dedicated image service (e.g. Cloud Run + Sharp). */
  _log('INFO', `Image job queued (stub)`, { path: job.storagePath, jobId: job._id });
}

/* ════════════════════════════════════════════════════════════════
   DISPATCHER
   Routes a job to its handler based on job.type or queue name.
   Returns true on success; throws on failure.
════════════════════════════════════════════════════════════════ */
const HANDLERS = {
  email:        handleEmail,
  notification: handleNotification,
  sms:          handleSMS,
  receipt:      handleReceipt,
  ai:           handleAI,
  report:       handleReport,
  bulk:         handleBulk,
  image:        handleImage,
};

async function dispatch(queue, job) {
  const handler = HANDLERS[queue] || HANDLERS[job.type];
  if (!handler) {
    _log('ERROR', `No handler for queue: ${queue}`, { jobId: job._id });
    throw new Error(`No handler for queue: ${queue}`);
  }

  const retries = job._retries || 0;
  if (retries > MAX_RETRIES) {
    await _deadLetter(queue, job, 'Max retries exceeded');
    return false;
  }

  try {
    await handler(job);
    await _audit(queue, job._id, 'completed');
    return true;
  } catch (err) {
    const newRetries = retries + 1;
    _log('ERROR', `Job failed (attempt ${newRetries}/${MAX_RETRIES})`, {
      queue, jobId: job._id, error: err.message,
    });
    await _audit(queue, job._id, 'failed', { error: err.message, retries: newRetries });

    if (newRetries > MAX_RETRIES) {
      await _deadLetter(queue, job, err.message);
    } else {
      /* Exponential backoff: re-queue with increasing score delay */
      const backoffMs = Math.pow(2, newRetries) * 5_000;
      await R.QueueService.push(queue, { ...job, _retries: newRetries }, 'normal');
      _log('INFO', `Job re-queued (backoff ${backoffMs}ms)`, { queue, jobId: job._id });
    }

    return false;
  }
}

module.exports = {
  dispatch,
  HANDLERS,
  // Individual handlers exported for direct testing
  handleEmail,
  handleNotification,
  handleSMS,
  handleReceipt,
  handleAI,
  handleReport,
  handleBulk,
  handleImage,
};
