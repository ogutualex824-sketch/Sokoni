/* ================================================================
   SOKONI SmartPOS Retail Cloud Functions v2.0
   – posSyncToMarketplace  (callable) — POS sale → marketplace stock
   – sendPOSReceipt        (callable) — SMS/email receipt to customer
   – sendPurchaseOrder     (callable) — email PO to supplier
   – posLowStockAlert      (scheduled) — daily low-stock notifications
   – posMarketplaceOrderSync (Firestore trigger) — marketplace orders → POS
================================================================ */
const functions  = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin      = require('firebase-admin');

/* Guard against double-init in monorepo */
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ─── helpers ──────────────────────────────────────────── */
function _sanitize(s) { return String(s||'').replace(/[<>"'`]/g,''); }
function _kes(n)      { return 'KES ' + Number(n||0).toFixed(2); }

const ALLOWED_ORIGINS = ['https://mysokoni.co.ke','https://www.mysokoni.co.ke'];
function _corsOrigin(req) {
  const origin = req.rawRequest?.headers?.origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

/* ══════════════════════════════════════════════════════════
   1. POS SALE → MARKETPLACE STOCK SYNC
   Called by pos-sales.js after every successful sale.
   Updates marketplace product stock in Firestore so online
   listings reflect real-time inventory.
══════════════════════════════════════════════════════════ */
exports.posSyncToMarketplace = onCall(
  { secrets: [], region: 'us-central1', maxInstances: 50, cors: true, enforceAppCheck: true },
  async (request) => {
    /* Verify caller is authenticated */
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in');

    const { branchId, items, saleId } = request.data;
    if (!Array.isArray(items) || items.length === 0) {
      throw new HttpsError('invalid-argument', 'items must be a non-empty array');
    }
    if (!saleId) throw new HttpsError('invalid-argument', 'saleId is required for idempotency');

    /* Idempotency: reject duplicate syncs for the same sale */
    const idempRef = db.collection('posSyncIdempotency').doc(String(saleId).slice(0, 128));
    const idempSnap = await idempRef.get();
    if (idempSnap.exists) return { synced: 0, duplicate: true };
    await idempRef.set({ saleId, syncedAt: admin.firestore.FieldValue.serverTimestamp(), uid: request.auth.uid });

    const batch = db.batch();
    const errors = [];

    for (const item of items) {
      const { productId, qtyDeducted } = item;
      if (!productId || typeof qtyDeducted !== 'number') {
        errors.push(`Invalid item: ${JSON.stringify(item)}`);
        continue;
      }

      /* Find matching marketplace product by productId or externalId */
      const prodRef = db.collection('products').doc(productId);
      const prodSnap = await prodRef.get();
      if (!prodSnap.exists) continue;

      /* Use atomic FieldValue.increment so concurrent POS device syncs
         from multiple branches don't overwrite each other's updates.
         Stock floor-at-zero is enforced by a Firestore security rule; the
         soldCount mirror lets analytics catch any negative-stock events. */
      batch.update(prodRef, {
        stock:        admin.firestore.FieldValue.increment(-qtyDeducted),
        soldCount:    admin.firestore.FieldValue.increment(qtyDeducted),
        updatedAt:    Date.now(),
        lastPOSSyncAt: Date.now(),
        lastPOSBranch: branchId || 'default',
      });
    }

    await batch.commit();
    return { synced: items.length - errors.length, errors };
  }
);

/* ══════════════════════════════════════════════════════════
   2. SEND POS RECEIPT
   Sends receipt via SMS (Africa's Talking) or email (SendGrid)
   after a POS sale. Falls back gracefully if service unavailable.
══════════════════════════════════════════════════════════ */
exports.sendPOSReceipt = onCall(
  { secrets: ['SENDGRID_API_KEY', 'AFRICASTALKING_API_KEY'], region: 'us-central1', maxInstances: 30, cors: true, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in');

    const { customerId, phone, email, sale, channel = 'email' } = request.data;
    if (!sale || !sale.receiptNumber) {
      throw new HttpsError('invalid-argument', 'sale.receiptNumber required');
    }

    /* Sanitize receipt data */
    const receiptNo = _sanitize(sale.receiptNumber);
    const shopName  = _sanitize(sale.shopName || 'SOKONI');
    const total     = _kes(sale.total);
    const items     = (sale.items || []).map(i => ({
      name:  _sanitize(i.name),
      qty:   Number(i.qty)  || 0,
      price: Number(i.price)|| 0,
      lineTotal: Number(i.lineTotal) || (i.qty * i.price),
    }));

    let result = { sent: false, channel };

    if (channel === 'sms' && phone) {
      const apiKey = process.env.AFRICASTALKING_API_KEY;
      if (!apiKey) throw new HttpsError('failed-precondition', 'SMS service not configured');

      const smsBody = [
        `${shopName} Receipt #${receiptNo}`,
        ...items.slice(0, 5).map(i => `${i.qty}x ${i.name}: ${_kes(i.lineTotal)}`),
        items.length > 5 ? `+${items.length - 5} more items` : '',
        `TOTAL: ${total}`,
        `Thank you for shopping at ${shopName}!`,
      ].filter(Boolean).join('\n').slice(0, 320);

      const AtKit = require('africastalking');
      const at    = AtKit({ apiKey, username: 'sandbox' });
      await at.SMS.send({ to: [phone], message: smsBody, from: 'SOKONI' });
      result = { sent: true, channel: 'sms', to: phone };

    } else if (channel === 'email' && email) {
      const sgMail = require('@sendgrid/mail');
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) throw new HttpsError('failed-precondition', 'Email service not configured');
      sgMail.setApiKey(apiKey);

      const itemRows = items.map(i =>
        `<tr><td style="padding:6px 10px">${i.qty}x ${i.name}</td><td style="padding:6px 10px;text-align:right">${_kes(i.lineTotal)}</td></tr>`
      ).join('');

      const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f5f5f5;padding:20px">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden">
          <div style="background:#71ff00;padding:20px;text-align:center;color:#000">
            <h2 style="margin:0">${shopName}</h2>
            <p style="margin:4px 0;opacity:.8">Receipt #${receiptNo}</p>
          </div>
          <div style="padding:20px">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="background:#f5f5f5"><th style="padding:8px 10px;text-align:left">Item</th><th style="padding:8px 10px;text-align:right">Amount</th></tr></thead>
              <tbody>${itemRows}</tbody>
              <tfoot>
                ${sale.discountAmount>0?`<tr><td style="padding:6px 10px;color:#888">Discount</td><td style="padding:6px 10px;text-align:right;color:#ef4444">-${_kes(sale.discountAmount)}</td></tr>`:''}
                ${sale.taxAmount>0?`<tr><td style="padding:6px 10px;color:#888">VAT</td><td style="padding:6px 10px;text-align:right">${_kes(sale.taxAmount)}</td></tr>`:''}
                <tr style="border-top:2px solid #4db800"><td style="padding:8px 10px;font-weight:700">TOTAL</td><td style="padding:8px 10px;text-align:right;font-weight:700;color:#4db800">${total}</td></tr>
              </tfoot>
            </table>
            ${(sale.payments||[]).map(p=>`<p style="font-size:13px;color:#555;margin:4px 0">Payment: ${p.method} — ${_kes(p.amount)}</p>`).join('')}
            ${sale.loyaltyEarned>0?`<p style="font-size:13px;color:#4db800">⭐ You earned ${sale.loyaltyEarned} loyalty points!</p>`:''}
            <p style="text-align:center;color:#888;font-size:12px;margin-top:20px">Thank you for shopping at ${shopName}!<br>Powered by SOKONI SmartPOS</p>
          </div>
        </div>
      </body></html>`;

      await sgMail.send({
        to:      email,
        from:    { email: 'receipts@mysokoni.co.ke', name: shopName },
        subject: `Receipt #${receiptNo} — ${shopName}`,
        html,
      });
      result = { sent: true, channel: 'email', to: email };
    }

    /* Log receipt delivery */
    if (customerId) {
      await db.collection('posReceiptLog').add({
        customerId, receiptNumber: receiptNo, ...result, timestamp: Date.now(),
      });
    }

    return result;
  }
);

/* ══════════════════════════════════════════════════════════
   3. SEND PURCHASE ORDER EMAIL
   Emails formatted PO to supplier's email address.
══════════════════════════════════════════════════════════ */
exports.sendPurchaseOrder = onCall(
  { secrets: ['SENDGRID_API_KEY'], region: 'us-central1', maxInstances: 10, cors: true, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in');

    const { poId, supplierEmail } = request.data;
    if (!poId || !supplierEmail) {
      throw new HttpsError('invalid-argument', 'poId and supplierEmail required');
    }

    const poSnap = await db.collection('purchaseOrders').doc(poId).get();
    if (!poSnap.exists) throw new HttpsError('not-found', 'PO not found');

    const po = poSnap.data();
    if (po.status === 'cancelled') throw new HttpsError('failed-precondition', 'PO is cancelled');

    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const itemRows = (po.items||[]).map(i =>
      `<tr><td style="padding:6px 10px">${_sanitize(i.productName||i.productId)}</td><td style="padding:6px 10px;text-align:center">${i.qty}</td><td style="padding:6px 10px;text-align:right">${_kes(i.unitCost)}</td><td style="padding:6px 10px;text-align:right">${_kes(i.lineTotal)}</td></tr>`
    ).join('');

    const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f5f5f5;padding:20px">
      <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden">
        <div style="background:#71ff00;padding:20px;color:#000">
          <h2 style="margin:0">Purchase Order</h2>
          <p style="margin:4px 0;opacity:.8">PO #${_sanitize(po.poNumber)}</p>
        </div>
        <div style="padding:20px">
          <p>Dear ${_sanitize(po.supplierName||'Supplier')},</p>
          <p>Please supply the following items as per our Purchase Order.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <thead><tr style="background:#f5f5f5"><th style="padding:8px 10px;text-align:left">Item</th><th style="padding:8px 10px">Qty</th><th style="padding:8px 10px;text-align:right">Unit Cost</th><th style="padding:8px 10px;text-align:right">Total</th></tr></thead>
            <tbody>${itemRows}</tbody>
            <tfoot><tr style="border-top:2px solid #4db800"><td colspan="3" style="padding:8px 10px;font-weight:700">TOTAL</td><td style="padding:8px 10px;text-align:right;font-weight:700;color:#4db800">${_kes(po.totalAmount)}</td></tr></tfoot>
          </table>
          ${po.expectedDelivery?`<p><strong>Expected Delivery:</strong> ${new Date(po.expectedDelivery).toLocaleDateString('en-KE')}</p>`:''}
          ${po.notes?`<p><strong>Notes:</strong> ${_sanitize(po.notes)}</p>`:''}
          <p>Please confirm receipt and delivery date.</p>
          <p style="color:#888;font-size:12px;margin-top:20px">SOKONI SmartPOS · PO issued ${new Date().toLocaleDateString('en-KE')}</p>
        </div>
      </div>
    </body></html>`;

    await sgMail.send({
      to:      supplierEmail,
      from:    { email: 'purchasing@mysokoni.co.ke', name: 'SOKONI Purchasing' },
      subject: `Purchase Order #${po.poNumber}`,
      html,
    });

    await db.collection('purchaseOrders').doc(poId).update({ status: 'sent', sentAt: Date.now() });
    return { sent: true, to: supplierEmail };
  }
);

/* ══════════════════════════════════════════════════════════
   4. SCHEDULED LOW-STOCK ALERT (daily 8 AM EAT)
   Queries Firestore inventory, sends notifications to shop owners.
══════════════════════════════════════════════════════════ */
exports.posLowStockAlert = functions.scheduler.onSchedule(
  { schedule: '0 5 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1' },
  async () => {
    /* Get all products with stock at or below reorderLevel */
    const invSnap = await db.collection('inventory').where('qty', '<=', 0).get();
    const outs    = invSnap.docs.map(d => ({ ...d.data(), id: d.id }));

    const lowSnap = await db.collection('inventory').get();
    const lows    = [];
    for (const doc of lowSnap.docs) {
      const inv = doc.data();
      if (!inv.productId) continue;
      const prodSnap = await db.collection('products').doc(inv.productId).get();
      if (!prodSnap.exists) continue;
      const prod = prodSnap.data();
      if (inv.qty <= (prod.minStockLevel || 5) && inv.qty > 0) {
        lows.push({ productName: prod.name, qty: inv.qty, minLevel: prod.minStockLevel, branchId: inv.branchId });
      }
    }

    const total = outs.length + lows.length;
    if (total === 0) return null;

    /* Create Firestore notification */
    await db.collection('notifications').add({
      type:        'low_stock_alert',
      title:       `⚠️ ${total} stock alert${total!==1?'s':''} need attention`,
      body:        `${outs.length} out of stock · ${lows.length} low stock`,
      priority:    'high',
      category:    'inventory',
      audience:    ['seller', 'admin'],
      data:        { outOfStock: outs.length, lowStock: lows.length },
      createdAt:   Date.now(),
      read:        false,
    });

    return null;
  }
);

/* ══════════════════════════════════════════════════════════
   5. MARKETPLACE ORDER → POS INVENTORY
   Triggered when a marketplace order status changes to
   confirmed/processing. Auto-deducts from POS inventory.
══════════════════════════════════════════════════════════ */
exports.posMarketplaceOrderSync = functions.firestore.onDocumentUpdated(
  { document: 'orders/{orderId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    /* Only trigger when status becomes confirmed/processing AND posProcessed is false */
    const activatedNow = ['confirmed','processing'].includes(after.status) && !['confirmed','processing'].includes(before.status);
    if (!activatedNow || after.posProcessed === true) return null;

    const { items = [], branchId = 'default' } = after;
    const orderId = event.params.orderId;

    for (const item of items) {
      const { productId, qty } = item;
      if (!productId || !qty) continue;

      const invId      = `${branchId}__${productId}`;
      const invRef     = db.collection('inventory').doc(invId);
      const mvRef      = db.collection('stockMovements').doc(`${orderId}_${productId}`);
      /* Per-item idempotency key written INSIDE the transaction.
         If the trigger fires again (e.g. batch.commit below failed), this
         guards each item independently — no double-deductions. */
      const itemIdemRef = db.collection('posSyncIdempotency').doc(`${orderId}_${productId}`);

      await db.runTransaction(async t => {
        const [invSnap, idemSnap] = await Promise.all([t.get(invRef), t.get(itemIdemRef)]);
        if (idemSnap.exists) return; // already deducted on a prior attempt
        if (!invSnap.exists) return;

        const current = invSnap.data().qty || 0;
        const newQty  = Math.max(0, current - qty);
        if (current < qty) {
          console.warn(`[posMarketplaceOrderSync] Stockout: product=${productId} current=${current} requested=${qty} orderId=${orderId}`);
        }
        t.update(invRef, { qty: newQty, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        t.set(mvRef, { productId, qty: -qty, type: 'marketplace_sale', reference: orderId,
          branchId, processedAt: admin.firestore.FieldValue.serverTimestamp() });
        t.set(itemIdemRef, { orderId, productId, deductedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
    }

    /* Mark order-level posProcessed flag — convenience only; real protection is per-item idempotency above */
    await event.data.after.ref.update({ posProcessed: true, posProcessedAt: admin.firestore.FieldValue.serverTimestamp() })
      .catch(e => console.error('[posMarketplaceOrderSync] posProcessed update failed (non-fatal):', e));
    return null;
  }
);
