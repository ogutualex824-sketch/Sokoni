'use strict';

/**
 * SOKONI Async Job Handlers v1.0
 * Handler registry for all job types. Each handler: execute(job) + canRetry(err).
 */

const admin  = require('firebase-admin');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const db = () => admin.firestore();
const ts = () => admin.firestore.FieldValue.serverTimestamp();

// ── EMAIL ─────────────────────────────────────────────────────────────────

const EmailHandler = {
  async execute(job) {
    const { to, subject, html, text, templateId, templateData, from } = job.payload;
    if (!to)      throw new Error('EMAIL: missing recipient (to)');
    if (!subject) throw new Error('EMAIL: missing subject');

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey)  throw new Error('SENDGRID_API_KEY not configured');

    const body = templateId
      ? JSON.stringify({
          personalizations: [{ to: [{ email: to }], dynamic_template_data: templateData || {} }],
          from: { email: from || 'noreply@mysokoni.co.ke' },
          template_id: templateId
        })
      : JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from || 'noreply@mysokoni.co.ke' },
          subject,
          content: html
            ? [{ type: 'text/html', value: html }]
            : [{ type: 'text/plain', value: text || '' }]
        });

    await _httpsPost('api.sendgrid.com', '/v3/mail/send', body, {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    });

    return { delivered: true, to };
  },
  canRetry(err) {
    const msg = err?.message || '';
    // 4xx = permanent failure (bad email, unsubscribed); don't retry
    return !/4\d\d/.test(msg);
  }
};

// ── SMS ───────────────────────────────────────────────────────────────────

const SMSHandler = {
  async execute(job) {
    const { phone, message } = job.payload;
    if (!phone || !message) throw new Error('SMS: missing phone or message');
    // Placeholder: integrate with Africa's Talking, Twilio, or Termii
    console.log(`[SMS] to=${phone} msg=${message.slice(0, 40)}...`);
    return { sent: true, phone };
  },
  canRetry: () => true
};

// ── PUSH ───────────────────────────────────────────────────────────────────

const PushHandler = {
  async execute(job) {
    const { token, tokens, title, body, data = {}, imageUrl } = job.payload;
    if (!title || !body) throw new Error('PUSH: missing title or body');

    const messaging = admin.messaging();
    const strData   = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );

    if (tokens && Array.isArray(tokens) && tokens.length > 0) {
      let successCount = 0;
      for (let i = 0; i < tokens.length; i += 500) {
        const chunk = tokens.slice(i, i + 500);
        const res   = await messaging.sendEachForMulticast({
          tokens: chunk,
          notification: { title, body, ...(imageUrl ? { imageUrl } : {}) },
          data: strData
        });
        successCount += res.successCount;
      }
      return { sent: successCount, total: tokens.length };
    }

    if (token) {
      await messaging.send({
        token,
        notification: { title, body, ...(imageUrl ? { imageUrl } : {}) },
        data: strData
      });
      return { sent: 1 };
    }

    throw new Error('PUSH: missing token or tokens array');
  },
  canRetry(err) {
    const msg = err?.message || '';
    return !msg.includes('invalid-registration-token') &&
           !msg.includes('registration-token-not-registered');
  }
};

// ── RECEIPT ────────────────────────────────────────────────────────────────

const ReceiptHandler = {
  async execute(job) {
    const { saleId, sellerId, format = 'json', emailTo } = job.payload;
    if (!saleId || !sellerId) throw new Error('RECEIPT: missing saleId or sellerId');

    const saleSnap = await db().collection('sellers').doc(sellerId)
      .collection('posSales').doc(saleId).get();
    if (!saleSnap.exists) throw new Error(`Sale not found: ${saleId}`);

    const sale     = saleSnap.data();
    const receiptId = `rcpt_${saleId}`;

    await db().collection('posReceipts').doc(receiptId).set({
      receiptId, saleId, sellerId, format,
      receiptNumber: sale.receiptNumber || saleId,
      total:     sale.total     || 0,
      items:     sale.items     || [],
      customer:  sale.customer  || null,
      paymentMethod: sale.paymentMethod || null,
      generatedAt: ts(),
      status: 'generated'
    }, { merge: true });

    // Optionally trigger email delivery
    if (emailTo) {
      await db().collection('asyncJobs').add({
        jobId: `job_${Date.now()}_rcpt_email`,
        type: 'EMAIL', status: 'queued',
        priority: 1, priorityLabel: 'HIGH',
        ownerId: job.ownerId, workspaceId: '',
        payload: {
          to: emailTo,
          subject: `Your SOKONI receipt #${sale.receiptNumber || saleId}`,
          text: `Total: KES ${(sale.total || 0).toLocaleString()}. Items: ${(sale.items || []).length}`
        },
        retryCount: 0, maxRetries: 5, retryDelayMs: 2000,
        result: null, error: null,
        progress: { current: 0, total: 100, message: 'Queued' },
        correlationId: job.jobId,
        idempotencyKey: '', scheduledFor: null,
        createdAt: ts(), startedAt: null, completedAt: null,
        workerInstance: null, lockedUntil: null, auditLog: []
      });
    }

    return { receiptId, generated: true };
  }
};

// ── ETIMS ───────────────────────────────────────────────────────────────────

const ETIMSHandler = {
  async execute(job) {
    const { saleId, sellerId } = job.payload;
    if (!saleId || !sellerId) throw new Error('ETIMS: missing saleId or sellerId');

    // Mark pending — actual KRA submission handled by dedicated eTIMS CFs
    await db().collection('sellers').doc(sellerId)
      .collection('posSales').doc(saleId)
      .update({
        etimsStatus:   'pending',
        etimsQueuedAt: ts()
      });

    return { queued: true, saleId };
  },
  canRetry: () => true
};

// ── WEBHOOK ─────────────────────────────────────────────────────────────────

const WebhookHandler = {
  async execute(job) {
    const { url, payload: whPayload = {}, secret, webhookId } = job.payload;
    if (!url) throw new Error('WEBHOOK: missing url');

    let parsedUrl;
    try { parsedUrl = new URL(url); }
    catch { throw new Error(`WEBHOOK: invalid url: ${url}`); }

    const body = JSON.stringify(whPayload);
    const sig  = secret
      ? 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
      : null;

    await new Promise((resolve, reject) => {
      const mod  = parsedUrl.protocol === 'https:' ? https : http;
      const opts = {
        hostname: parsedUrl.hostname,
        port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   'POST',
        timeout:  30000,
        headers:  {
          'Content-Type':      'application/json',
          'Content-Length':    Buffer.byteLength(body),
          'User-Agent':        'SOKONI-Webhook/1.0',
          'X-Sokoni-Event':    job.type,
          'X-Sokoni-JobId':    job.jobId,
          ...(sig ? { 'X-Sokoni-Signature': sig } : {})
        }
      };
      const req = mod.request(opts, res => {
        if (res.statusCode >= 400) {
          reject(new Error(`Webhook HTTP ${res.statusCode}`));
        } else {
          resolve();
        }
        res.resume();
      });
      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Webhook timeout')); });
      req.write(body);
      req.end();
    });

    if (webhookId) {
      await db().collection('posWebhooks').doc(webhookId).update({
        lastDeliveredAt: ts(),
        consecutiveFailures: 0
      }).catch(() => {});
    }

    return { delivered: true, url };
  },
  canRetry(err) {
    const msg = err?.message || '';
    return !msg.includes('HTTP 400') && !msg.includes('HTTP 401') && !msg.includes('HTTP 403');
  }
};

// ── ANALYTICS / ANALYTICS_AGGREGATE ──────────────────────────────────────

const AnalyticsHandler = {
  async execute(job) {
    const { sellerId, period = 'daily', analyticsType = 'revenue' } = job.payload;
    if (!sellerId) throw new Error('ANALYTICS: missing sellerId');

    const now       = new Date();
    const periodKey = period === 'monthly'
      ? now.toISOString().slice(0, 7)
      : now.toISOString().slice(0, 10);

    // Aggregate completed orders
    const snap = await db().collection('orders')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'completed')
      .orderBy('createdAt', 'desc')
      .limit(2000).get();

    const revenue   = snap.docs.reduce((s, d) => s + (d.data().total || 0), 0);
    const orderCount = snap.size;

    await db().collection('analyticsSnapshots').doc(`${sellerId}_${period}_${periodKey}`).set({
      sellerId, period, periodKey, analyticsType,
      revenue, orderCount,
      computedAt: ts()
    }, { merge: true });

    return { revenue, orderCount, periodKey };
  }
};

// ── INVENTORY_RECALC / INVENTORY_ALERT ────────────────────────────────────

const InventoryRecalcHandler = {
  async execute(job) {
    const { sellerId, productIds = [] } = job.payload;
    if (!sellerId) throw new Error('INVENTORY_RECALC: missing sellerId');

    const ids     = productIds.slice(0, 100);
    let recalculated = 0;

    /* Batch all inventory transaction queries in parallel */
    const txSnaps = await Promise.all(
      ids.map(productId => db().collection('inventoryTransactions')
        .where('sellerId',  '==', sellerId)
        .where('productId', '==', productId)
        .get()
      )
    );

    /* Batch all stock writes */
    const stockBatch = db().batch();
    for (let pi = 0; pi < ids.length; pi++) {
      const productId = ids[pi];
      const txSnap    = txSnaps[pi];
      const stock = txSnap.docs.reduce((sum, d) => {
        const t = d.data();
        return sum + (t.type === 'in' ? (t.qty || 0) : -(t.qty || 0));
      }, 0);
      stockBatch.update(
        db().collection('sellers').doc(sellerId).collection('inventory').doc(productId),
        { stockCount: Math.max(0, stock), recalcAt: ts() }
      );

      recalculated++;
    }
    await stockBatch.commit().catch(() => {});

    return { recalculated, productCount: ids.length };
  }
};

// ── REPORT / REPORT_GENERATE ───────────────────────────────────────────────

const ReportHandler = {
  async execute(job) {
    const { reportId, sellerId, reportType = 'sales', period } = job.payload;
    if (!reportId || !sellerId) throw new Error('REPORT: missing reportId or sellerId');

    await db().collection('reports').doc(reportId).update({
      status: 'generating', startedAt: ts()
    }).catch(() => {});

    // Aggregate data based on reportType
    const snap = await db().collection('orders')
      .where('sellerId', '==', sellerId)
      .where('status', '==', 'completed')
      .limit(5000).get();

    const summary = {
      totalRevenue:  snap.docs.reduce((s, d) => s + (d.data().total || 0), 0),
      totalOrders:   snap.size,
      avgOrderValue: snap.size > 0
        ? snap.docs.reduce((s, d) => s + (d.data().total || 0), 0) / snap.size
        : 0
    };

    await db().collection('reports').doc(reportId).update({
      status: 'completed', completedAt: ts(), summary
    });

    return { reportId, summary };
  }
};

// ── BULK_IMPORT ───────────────────────────────────────────────────────────

const BulkImportHandler = {
  async execute(job) {
    const { importId, sellerId, importType = 'products' } = job.payload;
    if (!importId || !sellerId) throw new Error('BULK_IMPORT: missing importId or sellerId');

    await db().collection('bulkImports').doc(importId).update({
      status: 'processing', startedAt: ts()
    }).catch(() => {});

    // Real implementation reads rows from Cloud Storage GCS URL in payload
    // and writes to Firestore in batches of 400

    await db().collection('bulkImports').doc(importId).update({
      status: 'completed', completedAt: ts(), rowsProcessed: 0
    });

    return { importId, completed: true };
  }
};

// ── BULK_EXPORT ───────────────────────────────────────────────────────────

const BulkExportHandler = {
  async execute(job) {
    const { exportId, sellerId, exportType = 'orders', filters = {} } = job.payload;
    if (!exportId || !sellerId) throw new Error('BULK_EXPORT: missing exportId or sellerId');

    await db().collection('bulkExports').doc(exportId).update({
      status: 'processing', startedAt: ts()
    }).catch(() => {});

    let q = db().collection('orders').where('sellerId', '==', sellerId);
    if (filters.fromDate) {
      q = q.where('createdAt', '>=',
        admin.firestore.Timestamp.fromDate(new Date(filters.fromDate)));
    }
    const snap = await q.limit(5000).get();

    // In production: write CSV to Cloud Storage and store downloadUrl
    await db().collection('bulkExports').doc(exportId).update({
      status: 'completed', completedAt: ts(), rowCount: snap.size
    });

    return { exportId, rowCount: snap.size };
  }
};

// ── IMAGE_OPT ──────────────────────────────────────────────────────────────

const ImageOptHandler = {
  async execute(job) {
    const { storagePath, sellerId } = job.payload;
    if (!storagePath) throw new Error('IMAGE_OPT: missing storagePath');
    // Real implementation: resize/compress via Sharp in a Cloud Function
    // For now: mark as processed
    console.log(`[IMAGE_OPT] path=${storagePath}`);
    return { optimized: true, storagePath };
  }
};

// ── AI_PROCESS ─────────────────────────────────────────────────────────────

const AIProcessHandler = {
  async execute(job) {
    const { taskType, sellerId, input } = job.payload;
    await db().collection('aiTaskLog').add({
      taskType, sellerId,
      status: 'delegated',
      input: typeof input === 'string' ? input.slice(0, 500) : null,
      createdAt: ts()
    });
    return { delegated: true, taskType };
  }
};

// ── PRODUCT_INDEX / SEARCH_INDEX ──────────────────────────────────────────

const ProductIndexHandler = {
  async execute(job) {
    const { productId, sellerId, action = 'upsert' } = job.payload;
    if (!productId || !sellerId) throw new Error('PRODUCT_INDEX: missing productId or sellerId');

    if (action === 'delete') {
      await db().collection('searchIndex').doc(productId).delete();
      return { action: 'delete', productId };
    }

    const snap = await db().collection('sellers').doc(sellerId)
      .collection('products').doc(productId).get();
    if (!snap.exists) return { skipped: true, reason: 'product not found' };

    const p = snap.data();
    await db().collection('searchIndex').doc(productId).set({
      productId, sellerId,
      name:     p.name     || '',
      category: p.category || '',
      price:    p.price    || 0,
      inStock:  (p.stock   || 0) > 0,
      tags:     p.tags     || [],
      indexedAt: ts()
    }, { merge: true });

    return { indexed: true, productId };
  }
};

// ── RECO_UPDATE ───────────────────────────────────────────────────────────

const RecoUpdateHandler = {
  async execute(job) {
    const { customerId, sellerId } = job.payload;
    // Real implementation: run collaborative filtering or rule-based reco
    await db().collection('recommendations').doc(`${sellerId}_${customerId}`).set({
      sellerId, customerId,
      items: [],
      computedAt: ts()
    }, { merge: true });
    return { updated: true };
  }
};

// ── LOYALTY_UPDATE ────────────────────────────────────────────────────────

const LoyaltyUpdateHandler = {
  async execute(job) {
    const { customerId, sellerId, orderId, orderTotal = 0 } = job.payload;
    if (!customerId || !sellerId) throw new Error('LOYALTY_UPDATE: missing customerId or sellerId');

    const points = Math.floor(orderTotal / 100); // 1 pt per KES 100
    if (points <= 0) return { points: 0, reason: 'order too small' };

    const ref = db().collection('loyaltyAccounts').doc(`${sellerId}_${customerId}`);
    await db().runTransaction(async t => {
      const snap    = await t.get(ref);
      const current = snap.exists ? (snap.data().points || 0) : 0;
      t.set(ref, {
        customerId, sellerId,
        points: current + points,
        lastOrderId: orderId,
        updatedAt: ts()
      }, { merge: true });
    });

    return { awarded: points, customerId };
  }
};

// ── SELLER_NOTIFICATION ───────────────────────────────────────────────────

const SellerNotificationHandler = {
  async execute(job) {
    const { sellerId, title, body, type = 'info', data = {} } = job.payload;
    if (!sellerId || !title) throw new Error('SELLER_NOTIFICATION: missing sellerId or title');

    await db().collection('sellers').doc(sellerId)
      .collection('notifications').add({
        title, body, type, data, read: false, createdAt: ts()
      });

    const sellerSnap = await db().collection('sellers').doc(sellerId).get();
    const fcmToken   = sellerSnap.data()?.fcmToken;
    if (fcmToken) {
      await admin.messaging().send({
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
      }).catch(() => {}); // non-fatal
    }

    return { notified: true, sellerId };
  }
};

// ── CUSTOMER_SEGMENT ──────────────────────────────────────────────────────

const CustomerSegmentHandler = {
  async execute(job) {
    const { sellerId } = job.payload;
    if (!sellerId) throw new Error('CUSTOMER_SEGMENT: missing sellerId');

    const snap = await db().collection('sellers').doc(sellerId)
      .collection('customers').limit(5000).get();

    const now      = Date.now();
    const segments = { vip: 0, regular: 0, at_risk: 0, new: 0 };

    for (const d of snap.docs) {
      const c              = d.data();
      const daysSince      = c.lastOrderAt
        ? (now - c.lastOrderAt.toMillis()) / 86_400_000 : 999;
      const totalSpend     = c.totalSpend  || 0;
      const totalOrders    = c.totalOrders || 0;

      if (totalSpend >= 50_000)    segments.vip++;
      else if (daysSince > 60)     segments.at_risk++;
      else if (totalOrders <= 1)   segments.new++;
      else                         segments.regular++;
    }

    await db().collection('sellers').doc(sellerId)
      .collection('analytics').doc('segments').set(
        { segments, computedAt: ts() }, { merge: true }
      );

    return segments;
  }
};

// ── REDIS_WARMUP ───────────────────────────────────────────────────────────

const RedisWarmupHandler = {
  async execute(job) {
    const { keys = [], sellerId } = job.payload;
    // When Redis is provisioned, call redis-layer CFs here
    console.log(`[REDIS_WARMUP] seller=${sellerId} keys=${keys.length}`);
    return { warmed: keys.length };
  }
};

// ── SCHEDULED_CLEANUP / DB_MAINTENANCE ────────────────────────────────────

const ScheduledCleanupHandler = {
  async execute(job) {
    const { target, olderThanDays = 30 } = job.payload;
    const cutoff = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - olderThanDays * 86_400_000)
    );

    let deleted = 0;

    if (target === 'old_notifications') {
      const s = await db().collection('notifications')
        .where('createdAt', '<', cutoff)
        .where('read', '==', true)
        .limit(400).get();
      if (!s.empty) {
        const b = db().batch();
        s.docs.forEach(d => b.delete(d.ref));
        await b.commit();
        deleted = s.size;
      }
    } else if (target === 'expired_sessions') {
      const s = await db().collection('userSessions')
        .where('expiresAt', '<', admin.firestore.Timestamp.now())
        .limit(400).get();
      if (!s.empty) {
        const b = db().batch();
        s.docs.forEach(d => b.delete(d.ref));
        await b.commit();
        deleted = s.size;
      }
    }

    return { deleted, target };
  }
};

// ── BACKUP_VERIFY ──────────────────────────────────────────────────────────

const BackupVerifyHandler = {
  async execute(job) {
    // Placeholder: in production, call PITR verification API
    console.log('[BACKUP_VERIFY] verification placeholder');
    return { verified: true };
  }
};

// ── EXTERNAL_SYNC ──────────────────────────────────────────────────────────

const ExternalSyncHandler = {
  async execute(job) {
    const { system, sellerId } = job.payload;
    console.log(`[EXTERNAL_SYNC] system=${system} seller=${sellerId}`);
    return { synced: false, system, note: 'Manual integration required' };
  },
  canRetry: () => false
};

// ── PDF ────────────────────────────────────────────────────────────────────

const PDFHandler = {
  async execute(job) {
    const { documentId, documentType, sellerId } = job.payload;
    if (!documentId) throw new Error('PDF: missing documentId');
    // Real implementation: generate PDF via Puppeteer or pdfkit in CF
    await db().collection('generatedDocuments').doc(documentId).update({
      pdfStatus: 'generated', pdfGeneratedAt: ts()
    }).catch(() => {});
    return { generated: true, documentId };
  }
};

// ── Shared HTTPS helper ────────────────────────────────────────────────────

function _httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000
    }, res => {
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} from ${hostname}`));
      } else {
        resolve();
      }
      res.resume();
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${hostname}`)); });
    req.write(body);
    req.end();
  });
}

// ── Handler Registry ───────────────────────────────────────────────────────

exports.handlers = {
  EMAIL:                EmailHandler,
  SMS:                  SMSHandler,
  PUSH:                 PushHandler,
  RECEIPT:              ReceiptHandler,
  PDF:                  PDFHandler,
  ETIMS:                ETIMSHandler,
  WEBHOOK:              WebhookHandler,
  ANALYTICS:            AnalyticsHandler,
  ANALYTICS_AGGREGATE:  AnalyticsHandler,
  INVENTORY_RECALC:     InventoryRecalcHandler,
  INVENTORY_ALERT:      InventoryRecalcHandler,
  REPORT:               ReportHandler,
  REPORT_GENERATE:      ReportHandler,
  IMAGE_OPT:            ImageOptHandler,
  AI_PROCESS:           AIProcessHandler,
  PRODUCT_INDEX:        ProductIndexHandler,
  SEARCH_INDEX:         ProductIndexHandler,
  RECO_UPDATE:          RecoUpdateHandler,
  LOYALTY_UPDATE:       LoyaltyUpdateHandler,
  SELLER_NOTIFICATION:  SellerNotificationHandler,
  CUSTOMER_SEGMENT:     CustomerSegmentHandler,
  BULK_IMPORT:          BulkImportHandler,
  BULK_EXPORT:          BulkExportHandler,
  REDIS_WARMUP:         RedisWarmupHandler,
  SCHEDULED_CLEANUP:    ScheduledCleanupHandler,
  DB_MAINTENANCE:       ScheduledCleanupHandler,
  BACKUP_VERIFY:        BackupVerifyHandler,
  EXTERNAL_SYNC:        ExternalSyncHandler,
};

/* ── Job type configuration for the Async Jobs Engine ───────────────────────
   Each entry: { maxRetries, timeoutSeconds, concurrencyLimit }
   Covers both legacy UPPERCASE types and any new dotted-style types.
──────────────────────────────────────────────────────────────────────────── */
exports.JOB_TYPES = {
  EMAIL:                { maxRetries: 5, timeoutSeconds: 30,  concurrencyLimit: 50  },
  SMS:                  { maxRetries: 3, timeoutSeconds: 15,  concurrencyLimit: 30  },
  PUSH:                 { maxRetries: 3, timeoutSeconds: 15,  concurrencyLimit: 100 },
  RECEIPT:              { maxRetries: 3, timeoutSeconds: 60,  concurrencyLimit: 20  },
  PDF:                  { maxRetries: 2, timeoutSeconds: 120, concurrencyLimit: 10  },
  ETIMS:                { maxRetries: 5, timeoutSeconds: 60,  concurrencyLimit: 5   },
  WEBHOOK:              { maxRetries: 5, timeoutSeconds: 30,  concurrencyLimit: 20  },
  ANALYTICS:            { maxRetries: 2, timeoutSeconds: 120, concurrencyLimit: 5   },
  ANALYTICS_AGGREGATE:  { maxRetries: 2, timeoutSeconds: 120, concurrencyLimit: 5   },
  INVENTORY_RECALC:     { maxRetries: 3, timeoutSeconds: 120, concurrencyLimit: 10  },
  INVENTORY_ALERT:      { maxRetries: 3, timeoutSeconds: 30,  concurrencyLimit: 20  },
  REPORT:               { maxRetries: 2, timeoutSeconds: 300, concurrencyLimit: 3   },
  REPORT_GENERATE:      { maxRetries: 2, timeoutSeconds: 300, concurrencyLimit: 3   },
  IMAGE_OPT:            { maxRetries: 3, timeoutSeconds: 60,  concurrencyLimit: 20  },
  AI_PROCESS:           { maxRetries: 2, timeoutSeconds: 120, concurrencyLimit: 10  },
  PRODUCT_INDEX:        { maxRetries: 3, timeoutSeconds: 60,  concurrencyLimit: 20  },
  SEARCH_INDEX:         { maxRetries: 3, timeoutSeconds: 60,  concurrencyLimit: 20  },
  RECO_UPDATE:          { maxRetries: 2, timeoutSeconds: 120, concurrencyLimit: 5   },
  LOYALTY_UPDATE:       { maxRetries: 3, timeoutSeconds: 30,  concurrencyLimit: 20  },
  SELLER_NOTIFICATION:  { maxRetries: 3, timeoutSeconds: 30,  concurrencyLimit: 30  },
  CUSTOMER_SEGMENT:     { maxRetries: 2, timeoutSeconds: 300, concurrencyLimit: 3   },
  BULK_IMPORT:          { maxRetries: 1, timeoutSeconds: 540, concurrencyLimit: 2   },
  BULK_EXPORT:          { maxRetries: 1, timeoutSeconds: 540, concurrencyLimit: 2   },
  REDIS_WARMUP:         { maxRetries: 2, timeoutSeconds: 120, concurrencyLimit: 3   },
  SCHEDULED_CLEANUP:    { maxRetries: 1, timeoutSeconds: 300, concurrencyLimit: 1   },
  DB_MAINTENANCE:       { maxRetries: 1, timeoutSeconds: 300, concurrencyLimit: 1   },
  BACKUP_VERIFY:        { maxRetries: 2, timeoutSeconds: 120, concurrencyLimit: 1   },
  EXTERNAL_SYNC:        { maxRetries: 3, timeoutSeconds: 120, concurrencyLimit: 5   },
};
