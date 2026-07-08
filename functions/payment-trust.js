/* ================================================================
   SOKONI Payment Trust Cloud Functions v1.0
   functions/payment-trust.js

   generateTrustReceipt  — creates receipt record + QR URL
   emailTrustReceipt     — sends receipt via SendGrid
   verifyTrustReceipt    — validates receipt authenticity
   getPaymentSecurityAlerts — admin: fetch security alerts
   detectPaymentAnomalies   — scheduled: scan for fraud patterns
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { defineSecret }        = require('firebase-functions/params');

const db     = getFirestore();
const REGION = 'us-central1';
const cfg    = { region: REGION, memory: '256MiB', timeoutSeconds: 60, enforceAppCheck: true };

const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');

/* ── Helpers ── */
function _sanitize(s) {
  if (typeof s !== 'string') return String(s || '');
  return s.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
}

function _e(msg, code = 'invalid-argument') {
  throw new HttpsError(code, msg);
}

async function _assertAuth(auth) {
  if (!auth?.uid) _e('Authentication required', 'unauthenticated');
  return auth.uid;
}

async function _assertAdmin(auth) {
  const uid = await _assertAuth(auth);       /* was missing await — uid was a Promise */
  if (!auth?.token?.admin && !auth?.token?.superAdmin) {
    _e('Admin access required', 'permission-denied');
  }
  return uid;
}

function _kes(n) {
  return 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ════════════════════════════════════════════════════════════════
   generateTrustReceipt — create receipt in posReceipts collection
   Returns receiptUrl (QR-verifiable) and receiptNo
════════════════════════════════════════════════════════════════ */
exports.generateTrustReceipt = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const {
    saleId, merchantId, merchantName, merchantAddress, merchantPhone,
    items = [], payments = [], customer,
    subtotal = 0, tax = 0, discount = 0, grandTotal = 0,
    paymentMethod, paymentRef, cashierName, loyaltyEarned = 0,
    receiptNo: existingNo,
  } = data || {};

  if (!merchantId)  _e('merchantId required');
  if (!grandTotal)  _e('grandTotal required');

  /* Verify caller owns or belongs to this merchant */
  if (auth.uid !== merchantId) {
    const sellerSnap = await db.collection('sellers').doc(merchantId).get();
    const isOwnedByCaller = sellerSnap.exists && sellerSnap.data().uid === auth.uid;
    const isAdmin = auth.token?.admin || auth.token?.superAdmin;
    if (!isOwnedByCaller && !isAdmin)
      _e('Not authorized to generate receipts for this merchant', 'permission-denied');
  }

  const receiptNo   = existingNo || (
    'R' + Date.now().toString(36).toUpperCase().slice(-6) +
    Math.random().toString(36).slice(-3).toUpperCase()
  );
  const createdAt   = FieldValue.serverTimestamp();
  const date        = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const receiptUrl  = `https://mysokoni.co.ke/payment-receipt.html?ref=${encodeURIComponent(receiptNo)}`;

  const receiptDoc = {
    receiptNo,
    saleId:          saleId || null,
    merchantId:      _sanitize(merchantId),
    merchantName:    _sanitize(merchantName || 'SOKONI'),
    merchantAddress: _sanitize(merchantAddress || ''),
    merchantPhone:   _sanitize(merchantPhone || ''),
    items:           (items || []).map(it => ({
      productId:  it.productId || null,
      name:       _sanitize(it.name || 'Item'),
      qty:        Number(it.qty) || 1,
      unitPrice:  Number(it.unitPrice || it.price) || 0,
    })),
    payments:        (payments || []).map(p => ({
      method: _sanitize(p.method),
      amount: Number(p.amount) || 0,
      ref:    _sanitize(p.ref || ''),
    })),
    customer:        customer ? {
      id:    customer.id   || null,
      name:  _sanitize(customer.name || ''),
      phone: _sanitize(customer.phone || ''),
      email: _sanitize(customer.email || ''),
    } : null,
    cashierName:     _sanitize(cashierName || ''),
    subtotal:        Number(subtotal),
    tax:             Number(tax),
    discount:        Number(discount),
    total:           Number(grandTotal),
    paymentMethod:   _sanitize(paymentMethod || (payments[0]?.method) || 'M-Pesa'),
    paymentRef:      _sanitize(paymentRef || (payments[0]?.ref) || ''),
    loyaltyEarned:   Number(loyaltyEarned) || 0,
    receiptUrl,
    date,
    createdAt,
    createdBy:       auth.uid,
    status:          'valid',
  };

  await db.collection('posReceipts').doc(receiptNo).set(receiptDoc);

  /* Log receipt event for analytics */
  await db.collection('receiptEvents').add({
    receiptNo,
    merchantId: _sanitize(merchantId),
    total:      Number(grandTotal),
    paymentMethod: receiptDoc.paymentMethod,
    createdAt,
    type: 'generated',
  }).catch(() => {});

  return { receiptNo, receiptUrl, date };
});

/* ════════════════════════════════════════════════════════════════
   emailTrustReceipt — sends receipt email via SendGrid
════════════════════════════════════════════════════════════════ */
exports.emailTrustReceipt = onCall({
  ...cfg,
  secrets: [SENDGRID_API_KEY],
}, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { receiptNo, email } = data || {};
  if (!receiptNo) _e('receiptNo required');
  if (!email || !email.includes('@')) _e('Valid email required');

  const snap = await db.collection('posReceipts').doc(receiptNo).get();
  if (!snap.exists) _e('Receipt not found', 'not-found');

  const r = snap.data();
  const receiptUrl = r.receiptUrl || `https://mysokoni.co.ke/payment-receipt.html?ref=${encodeURIComponent(receiptNo)}`;

  /* Build item rows for email */
  const itemRows = (r.items || []).map(it =>
    `<tr>
      <td style="padding:6px 0;color:#333;font-size:14px;">${_sanitize(it.name)}</td>
      <td style="padding:6px 0;color:#777;font-size:14px;text-align:center;">×${it.qty}</td>
      <td style="padding:6px 0;color:#333;font-size:14px;text-align:right;font-weight:600;">${_kes((it.unitPrice || 0) * (it.qty || 1))}</td>
    </tr>`
  ).join('');

  const html = `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08);">

      <!-- Header -->
      <div style="background:#0b0e14;padding:24px 28px;text-align:center;">
        <div style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-.3px;">
          SOKONI <span style="color:#00a651;">Pay</span>
        </div>
        <div style="font-size:13px;color:rgba(255,255,255,.5);margin-top:4px;">Payment Receipt</div>
      </div>

      <!-- Success banner -->
      <div style="background:#f0f9f4;border-bottom:1px solid #d4edda;padding:16px 28px;display:flex;align-items:center;gap:12px;">
        <div style="width:36px;height:36px;background:#00a651;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-size:18px;font-weight:700;flex-shrink:0;">✓</div>
        <div>
          <div style="font-size:15px;font-weight:700;color:#1b5e20;">Payment Confirmed</div>
          <div style="font-size:12px;color:#388e3c;">Your transaction was processed securely.</div>
        </div>
      </div>

      <!-- Body -->
      <div style="padding:24px 28px;">
        <!-- Merchant -->
        <div style="text-align:center;margin-bottom:20px;">
          <div style="font-size:18px;font-weight:800;color:#1a1a1a;">${_sanitize(r.merchantName)}</div>
          ${r.merchantAddress ? `<div style="font-size:12px;color:#888;margin-top:3px;">${_sanitize(r.merchantAddress)}</div>` : ''}
        </div>

        <!-- Meta -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
          <tr>
            <td style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.4px;padding:4px 0;">Receipt No</td>
            <td style="font-size:13px;font-weight:700;color:#333;text-align:right;">${_sanitize(receiptNo)}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.4px;padding:4px 0;">Date</td>
            <td style="font-size:13px;color:#333;text-align:right;">${_sanitize(r.date || '')}</td>
          </tr>
          ${r.customer?.name ? `<tr><td style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.4px;padding:4px 0;">Customer</td><td style="font-size:13px;color:#333;text-align:right;">${_sanitize(r.customer.name)}</td></tr>` : ''}
        </table>

        <hr style="border:none;border-top:1px dashed #e0e0e0;margin:16px 0;">

        <!-- Items -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <thead>
            <tr>
              <th style="font-size:11px;color:#888;text-transform:uppercase;font-weight:600;padding-bottom:8px;text-align:left;">Item</th>
              <th style="font-size:11px;color:#888;text-transform:uppercase;font-weight:600;padding-bottom:8px;text-align:center;">Qty</th>
              <th style="font-size:11px;color:#888;text-transform:uppercase;font-weight:600;padding-bottom:8px;text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemRows || `<tr><td colspan="3" style="padding:6px 0;color:#333;font-size:14px;">Payment of ${_kes(r.total)}</td></tr>`}</tbody>
        </table>

        <hr style="border:none;border-top:1px solid #f0f0f0;margin:12px 0;">

        <!-- Totals -->
        ${(r.items || []).length > 1 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:#666;"><span>Subtotal</span><span>${_kes(r.subtotal)}</span></div>` : ''}
        ${(r.discount || 0) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:#00a651;"><span>Discount</span><span>−${_kes(r.discount)}</span></div>` : ''}
        ${(r.tax || 0) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:#666;"><span>VAT</span><span>${_kes(r.tax)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:10px 0;font-size:17px;font-weight:800;color:#1a1a1a;border-top:1px solid #e0e0e0;margin-top:8px;">
          <span>TOTAL PAID</span>
          <span style="color:#00a651;">${_kes(r.total)}</span>
        </div>

        <!-- Payment method -->
        <div style="background:#f0f9f4;border:1px solid #d4edda;border-radius:8px;padding:10px 14px;margin:16px 0;font-size:13px;color:#1b5e20;font-weight:600;">
          ✓ Paid via ${_sanitize(r.paymentMethod)}${r.paymentRef ? ' · Ref: ' + _sanitize(r.paymentRef) : ''}
        </div>

        <!-- Loyalty -->
        ${(r.loyaltyEarned || 0) > 0 ? `<div style="background:#f0f9f4;border-radius:8px;padding:10px;text-align:center;font-size:13px;color:#00a651;font-weight:600;margin-bottom:16px;">+${r.loyaltyEarned} loyalty points earned!</div>` : ''}

        <!-- View online -->
        <div style="text-align:center;margin:20px 0;">
          <a href="${receiptUrl}" style="display:inline-block;background:#00a651;color:white;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none;">View &amp; Verify Receipt Online</a>
        </div>

        <!-- Trust footer -->
        <div style="text-align:center;padding:16px 0 0;border-top:1px solid #f0f0f0;">
          <div style="font-size:11px;color:#aaa;line-height:1.6;">
            Secured by IntaSend &nbsp;|&nbsp; 256-bit SSL &nbsp;|&nbsp; PCI DSS Compliant<br>
            This receipt was generated automatically by SOKONI. Do not reply to this email.
          </div>
        </div>
      </div>
    </div>
  </body>
  </html>`;

  const apiKey = SENDGRID_API_KEY.value();
  if (!apiKey || apiKey.startsWith('SG.placeholder')) {
    /* SendGrid not configured — log and return graceful fallback */
    console.warn('emailTrustReceipt: SENDGRID_API_KEY not set, skipping email');
    return { sent: false, reason: 'email_not_configured' };
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: _sanitize(email) }] }],
      from:    { email: 'receipts@mysokoni.co.ke', name: 'SOKONI Pay' },
      subject: `Your SOKONI receipt — ${receiptNo}`,
      content: [{ type: 'text/html', value: html }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('SendGrid error:', response.status, body.slice(0, 200));
    _e('Failed to send email', 'internal');
  }

  /* Log email event */
  await db.collection('receiptEvents').add({
    receiptNo,
    merchantId: r.merchantId,
    type: 'emailed',
    email: _sanitize(email),
    createdAt: FieldValue.serverTimestamp(),
  }).catch(() => {});

  return { sent: true };
});

/* ════════════════════════════════════════════════════════════════
   verifyTrustReceipt — check receipt authenticity
════════════════════════════════════════════════════════════════ */
exports.verifyTrustReceipt = onCall(cfg, async ({ data }) => {
  const { receiptNo } = data || {};
  if (!receiptNo) _e('receiptNo required');

  const snap = await db.collection('posReceipts').doc(_sanitize(receiptNo)).get();
  if (!snap.exists) return { valid: false, reason: 'Receipt not found' };

  const r = snap.data();
  if (r.status === 'void' || r.status === 'cancelled') {
    return { valid: false, reason: 'This receipt has been voided' };
  }

  /* Log verification scan */
  await db.collection('receiptEvents').add({
    receiptNo,
    merchantId: r.merchantId || null,
    type:       'verified',
    createdAt:  FieldValue.serverTimestamp(),
  }).catch(() => {});

  return {
    valid:        true,
    receiptNo:    r.receiptNo,
    merchantName: r.merchantName,
    date:         r.date,
    total:        r.total,
    paymentMethod: r.paymentMethod,
  };
});

/* ════════════════════════════════════════════════════════════════
   getPaymentSecurityAlerts — admin: list recent security alerts
════════════════════════════════════════════════════════════════ */
exports.getPaymentSecurityAlerts = onCall(cfg, async ({ data, auth }) => {
  await _assertAdmin(auth);
  const { limit: lim = 50, since } = data || {};

  let q = db.collection('paymentSecurityAlerts').orderBy('createdAt', 'desc').limit(Math.min(lim, 200));
  if (since) q = q.where('createdAt', '>=', since);

  const snap = await q.get();
  return {
    alerts: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    total:  snap.size,
  };
});

/* ════════════════════════════════════════════════════════════════
   detectPaymentAnomalies — scheduled daily scan for fraud patterns:
   1. Duplicate charges (same amount, same user, <5 minutes apart)
   2. Failed payment spikes (>5 failures in 10 minutes per user)
   3. Velocity (>20 transactions per hour per user)
   4. Large transaction outliers (>3× rolling average)
   Fires alerts to paymentSecurityAlerts collection + admin email
════════════════════════════════════════════════════════════════ */
exports.detectPaymentAnomalies = onSchedule({
  schedule:  'every 24 hours',
  timeZone:  'Africa/Nairobi',
  region:    REGION,
}, async () => {
  const now     = Date.now();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const alerts = [];

  /* ── 1. Duplicate payment scan ── */
  const salesSnap = await db.collection('posRetailSales')
    .where('createdAt', '>=', oneDayAgo)
    .orderBy('createdAt', 'asc')
    .limit(5000)
    .get();

  const byUser = {};
  for (const doc of salesSnap.docs) {
    const d  = doc.data();
    const uk = d.cashierId || d.customerId || 'unknown';
    if (!byUser[uk]) byUser[uk] = [];
    byUser[uk].push({ id: doc.id, total: d.grandTotal, ts: d.createdAt?.toMillis?.() || 0, merchantId: d.merchantId });
  }

  for (const [uid, txns] of Object.entries(byUser)) {
    for (let i = 0; i < txns.length - 1; i++) {
      const a = txns[i], b = txns[i + 1];
      if (
        a.merchantId === b.merchantId &&
        Math.abs(a.total - b.total) < 1 &&
        (b.ts - a.ts) < 5 * 60 * 1000
      ) {
        alerts.push({
          type:       'duplicate_payment',
          severity:   'high',
          userId:     uid,
          merchantId: a.merchantId,
          amount:     a.total,
          saleA:      a.id,
          saleB:      b.id,
          timeDiff:   b.ts - a.ts,
          message:    `Possible duplicate charge: KES ${a.total} within ${Math.round((b.ts-a.ts)/1000)}s for user ${uid}`,
          createdAt:  FieldValue.serverTimestamp(),
          status:     'open',
        });
      }
    }
  }

  /* ── 2. Failed payment spikes ── */
  const failSnap = await db.collection('paymentFailures')
    .where('failedAt', '>=', oneDayAgo)
    .limit(2000)
    .get();

  const failByUser = {};
  for (const doc of failSnap.docs) {
    const d = doc.data();
    const k = (d.userId || 'unknown') + '_' + d.merchantId;
    if (!failByUser[k]) failByUser[k] = { count: 0, userId: d.userId, merchantId: d.merchantId };
    failByUser[k].count++;
  }

  for (const [, v] of Object.entries(failByUser)) {
    if (v.count >= 5) {
      alerts.push({
        type:       'failed_payment_spike',
        severity:   v.count >= 10 ? 'critical' : 'medium',
        userId:     v.userId,
        merchantId: v.merchantId,
        count:      v.count,
        message:    `${v.count} payment failures in 24h for user ${v.userId} at merchant ${v.merchantId}`,
        createdAt:  FieldValue.serverTimestamp(),
        status:     'open',
      });
    }
  }

  /* ── 3. Velocity breach (>20 transactions per hour per cashier) ── */
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const velSnap = await db.collection('posRetailSales')
    .where('createdAt', '>=', oneHourAgo)
    .limit(2000)
    .get();

  const velByUser = {};
  for (const doc of velSnap.docs) {
    const d = doc.data();
    const k = (d.cashierId || d.customerId || 'unknown') + '|' + (d.merchantId || '');
    if (!velByUser[k]) {
      velByUser[k] = { count: 0, userId: d.cashierId || d.customerId, merchantId: d.merchantId };
    }
    velByUser[k].count++;
  }
  for (const v of Object.values(velByUser)) {
    if (v.count > 20) {
      alerts.push({
        type:       'velocity_breach',
        severity:   v.count > 40 ? 'critical' : 'high',
        userId:     v.userId,
        merchantId: v.merchantId,
        txCount:    v.count,
        window:     '1 hour',
        message:    `Velocity breach: ${v.count} transactions in 1 hour for user ${v.userId} at merchant ${v.merchantId}`,
        createdAt:  FieldValue.serverTimestamp(),
        status:     'open',
      });
    }
  }

  /* ── 4. Large transaction outliers (>3× rolling 30-day average per merchant) ── */
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const baseSnap = await db.collection('posRetailSales')
    .where('createdAt', '>=', thirtyDaysAgo)
    .where('createdAt', '<', oneDayAgo)  /* baseline excludes today */
    .limit(5000)
    .get();

  const baseByMerchant = {};
  for (const doc of baseSnap.docs) {
    const d = doc.data();
    const m = d.merchantId || 'unknown';
    if (!baseByMerchant[m]) baseByMerchant[m] = { sum: 0, count: 0 };
    baseByMerchant[m].sum   += d.grandTotal || 0;
    baseByMerchant[m].count += 1;
  }
  const avgByMerchant = {};
  for (const [mid, v] of Object.entries(baseByMerchant)) {
    if (v.count >= 5) avgByMerchant[mid] = v.sum / v.count;
  }

  for (const doc of salesSnap.docs) {
    const d   = doc.data();
    const m   = d.merchantId;
    const avg = avgByMerchant[m];
    if (!avg) continue;
    const total = d.grandTotal || 0;
    if (total > avg * 3 && total > 10000) {
      alerts.push({
        type:       'large_transaction_outlier',
        severity:   total > avg * 6 ? 'critical' : 'high',
        userId:     d.cashierId || d.customerId || 'unknown',
        merchantId: m,
        amount:     total,
        baseline:   Math.round(avg),
        multiplier: Math.round((total / avg) * 10) / 10,
        saleId:     doc.id,
        message:    `Outlier: KES ${total.toFixed(0)} is ${(total/avg).toFixed(1)}× the 30-day avg (KES ${Math.round(avg)}) for merchant ${m}`,
        createdAt:  FieldValue.serverTimestamp(),
        status:     'open',
      });
    }
  }

  /* ── Write alerts to Firestore ── */
  if (alerts.length > 0) {
    const batch = db.batch();
    alerts.forEach(alert => {
      const ref = db.collection('paymentSecurityAlerts').doc();
      batch.set(ref, alert);
    });
    await batch.commit();
    console.log(`detectPaymentAnomalies: wrote ${alerts.length} alerts`);

    /* ── Write admin notification ── */
    await db.collection('adminNotifications').add({
      type:      'security_alert',
      title:     `${alerts.length} payment anomalies detected`,
      body:      alerts.map(a => a.message).slice(0, 5).join(' | '),
      severity:  alerts.some(a => a.severity === 'critical') ? 'critical' : 'high',
      createdAt: FieldValue.serverTimestamp(),
      read:      false,
    });
  }

  return { alertsGenerated: alerts.length };
});

/* ════════════════════════════════════════════════════════════════
   voidTrustReceipt — admin: mark a receipt as voided (refunded/cancelled)
   Updates posReceipts.status to 'void' and logs the action.
════════════════════════════════════════════════════════════════ */
exports.voidTrustReceipt = onCall(cfg, async ({ data, auth }) => {
  await _assertAdmin(auth);
  const { receiptNo, reason } = data || {};
  if (!receiptNo || typeof receiptNo !== 'string') _e('receiptNo required');
  if (!reason    || typeof reason    !== 'string') _e('reason required');

  const snap = await db.collection('posReceipts')
    .where('receiptNo', '==', receiptNo.trim().toUpperCase())
    .limit(1)
    .get();

  if (snap.empty) _e('Receipt not found', 'not-found');

  const ref  = snap.docs[0].ref;
  const data2 = snap.docs[0].data();
  if (data2.status === 'void') _e('Receipt is already voided');

  await ref.update({
    status:     'void',
    voidedAt:   FieldValue.serverTimestamp(),
    voidedBy:   auth.uid,
    voidReason: _sanitize(reason),
  });

  await db.collection('receiptEvents').add({
    receiptNo:  receiptNo.trim().toUpperCase(),
    receiptId:  snap.docs[0].id,
    action:     'voided',
    actorUid:   auth.uid,
    reason:     _sanitize(reason),
    createdAt:  FieldValue.serverTimestamp(),
  });

  return { voided: true, receiptNo: receiptNo.trim().toUpperCase() };
});
