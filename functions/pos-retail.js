/* ================================================================
   SOKONI SmartPOS Retail Cloud Functions v2.0
   – posSyncToMarketplace  (callable) — POS sale → marketplace stock
   – sendPOSReceipt        (callable) — SMS/email receipt to customer
   – sendPurchaseOrder     RETIRED 2026-09-03, see ADR-018. Superseded by
                           procurement.sendPurchaseOrder (functions/procurement.js),
                           the wired, structurally-complete PO lifecycle engine.
   – posLowStockAlert      (scheduled) — daily low-stock notifications
   – posMarketplaceOrderSync (Firestore trigger) — marketplace orders → POS
================================================================ */
const functions  = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin      = require('firebase-admin');

const SENDGRID_SK = defineSecret('SENDGRID_API_KEY');
const sokoniAt    = require('./sokoni-at');
const { COMPANY } = require('./company-identity');

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

    /* Inventory convergence B (2026-09-30). The old code was a blind batch of increment(-qtyDeducted): its comment
       said "floor-at-zero is enforced by a Firestore security rule", but this runs with the Admin SDK, which BYPASSES
       rules — so counted stock could go below zero, an unmetered item got stock:-qty, and a negative qtyDeducted
       RAISED stock. Now each item is its own transaction over the ONE stock decision
       (shared/sellability.planStockDeduction): the device has ALREADY sold it, so a short metered item is taken down
       to zero and the shortfall FLAGGED (oversoldAlerts), never refused; an unmetered item moves counters only. */
    const _SELL = require('./shared/sellability');
    const errors = [];
    let synced = 0;

    for (const item of items) {
      const { productId, qtyDeducted } = item;
      if (!productId || typeof qtyDeducted !== 'number' || !(qtyDeducted > 0)) {
        errors.push(`Invalid item: ${JSON.stringify(item)}`);
        continue;
      }

      /* Find matching marketplace product by productId or externalId */
      const prodRef = db.collection('products').doc(String(productId));
      try {
        await db.runTransaction(async (t) => {
          const prodSnap = await t.get(prodRef);
          if (!prodSnap.exists) return;
          const plan = _SELL.planStockDeduction(prodSnap.data(), qtyDeducted, { onShort: 'flag' });
          const upd = {
            soldCount:    admin.firestore.FieldValue.increment(qtyDeducted),
            updatedAt:    Date.now(),
            lastPOSSyncAt: Date.now(),
            lastPOSBranch: branchId || 'default',
          };
          if (plan.deduct > 0) {
            upd.stock            = admin.firestore.FieldValue.increment(-plan.deduct);
            upd.inventoryVersion = admin.firestore.FieldValue.increment(1);
          }
          if (plan.shortfall) {
            t.set(db.collection('oversoldAlerts').doc(), {
              productId: String(productId), requested: qtyDeducted, available: prodSnap.data().stock,
              reason: 'pos_device_sync', saleId: String(saleId), branchId: branchId || 'default',
              path: 'posSyncToMarketplace', createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
          t.update(prodRef, upd);
        });
        synced++;
      } catch (e) {
        errors.push(`${productId}: ${e.message}`);
      }
    }

    return { synced, errors };
  }
);

/* ══════════════════════════════════════════════════════════
   2. SEND POS RECEIPT
   Sends receipt via SMS (Africa's Talking) or email (SendGrid)
   after a POS sale. Falls back gracefully if service unavailable.
══════════════════════════════════════════════════════════ */
exports.sendPOSReceipt = onCall(
  { secrets: [SENDGRID_SK, ...sokoniAt.secrets], region: 'us-central1', maxInstances: 30, cors: true, enforceAppCheck: true },
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
      try {
        sokoniAt.resolveAtCredentials();
      } catch (e) {
        throw new HttpsError('failed-precondition', e.message);
      }

      const smsBody = [
        `${shopName} Receipt #${receiptNo}`,
        ...items.slice(0, 5).map(i => `${i.qty}x ${i.name}: ${_kes(i.lineTotal)}`),
        items.length > 5 ? `+${items.length - 5} more items` : '',
        `TOTAL: ${total}`,
        `Thank you for shopping at ${shopName}!`,
      ].filter(Boolean).join('\n').slice(0, 320);

      /* Route through the central sender. This previously called the AT SDK directly
         with a HARDCODED from:'SOKONI' — a sender ID that is still PENDING operator
         approval, so Africa's Talking would reject the message. The sender must come
         from AT_SENDER_ID (empty until approved), never from a literal. */
      const smsRes = await sokoniAt.atSendSMSWithRetry(phone, smsBody);
      if (!smsRes || !smsRes.ok) {
        throw new HttpsError('unavailable', 'Receipt SMS could not be sent.');
      }
      result = { sent: true, channel: 'sms', to: phone, messageId: (smsRes.results || [])[0]?.messageId || null };

    } else if (channel === 'email' && email) {
      const sgMail = require('@sendgrid/mail');
      const apiKey = SENDGRID_SK.value();
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
            <p style="text-align:center;color:#888;font-size:12px;margin-top:20px">Thank you for shopping at ${shopName}!<br>Powered by SOKONI SmartPOS<br>${COMPANY.operatedBy}</p>
          </div>
        </div>
      </body></html>`;

      try {
        await sgMail.send({
          to:      email,
          from:    { email: 'receipts@mysokoni.co.ke', name: shopName },
          subject: `Receipt #${receiptNo} — ${shopName}`,
          html,
        });
      } catch (e) {
        logger.error('sendgrid error', e.message);
        throw new HttpsError('internal', 'Failed to send receipt email');
      }
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
   3. sendPurchaseOrder — RETIRED 2026-09-03, see docs/adr/ADR-018-legacy-retirement-graph.md.
   Was exported as posSendPurchaseOrder in index.js: a standalone "email an
   existing purchaseOrders/{poId} doc" callable with no createPurchaseOrder/
   approvePurchaseOrder/receiveGoods lifecycle around it. Zero code-level
   callers anywhere in the repo, and zero Cloud Logging invocation entries
   across the full ~30-day retention window covering the Cloud Run service
   (possendpurchaseorder), against a control query (poscompletecheckout,
   122 entries same window) proving the logging pipe itself is not silent.
   Superseded by the structurally-complete procurement.sendPurchaseOrder
   (functions/procurement.js), which IS wired to real callers (inventory.html,
   pos-suppliers.js) and is NOT retired here — that endpoint having its own
   zero production traffic in the same window is a separate, still-open
   lifecycle-use question, not a retirement decision. Removed to reclaim one
   Cloud Run slot; no functional behaviour was lost — nothing called this. */

/* ══════════════════════════════════════════════════════════
   4. SCHEDULED LOW-STOCK ALERT (daily 8 AM EAT)
   Queries Firestore inventory, sends notifications to shop owners.
══════════════════════════════════════════════════════════ */
exports.posLowStockAlert = functions.scheduler.onSchedule(
  { schedule: '0 5 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1' },
  async () => {
    /* Get all products with stock at or below reorderLevel */
    const invSnap = await db.collection('inventory').where('qty', '<=', 0).limit(500).get();
    const outs    = invSnap.docs.map(d => ({ ...d.data(), id: d.id }));

    // Query low-stock items (qty > 0 but at or below threshold) with a limit
    // instead of a full collection scan. Batch all product lookups via getAll()
    // to replace the previous O(n) serial read pattern.
    const lowSnap = await db.collection('inventory').where('qty', '>', 0).limit(500).get();
    const lows    = [];
    if (!lowSnap.empty) {
      const uniqueProductIds = [...new Set(
        lowSnap.docs.map(d => d.data().productId).filter(Boolean)
      )];
      const productRefs  = uniqueProductIds.map(id => db.collection('products').doc(id));
      const productSnaps = productRefs.length > 0 ? await db.getAll(...productRefs) : [];
      const productMap   = {};
      for (const s of productSnaps) { if (s.exists) productMap[s.id] = s.data(); }

      for (const doc of lowSnap.docs) {
        const inv  = doc.data();
        const prod = inv.productId ? productMap[inv.productId] : null;
        if (!prod) continue;
        if (inv.qty <= (prod.minStockLevel || 5)) {
          lows.push({ productName: prod.name, qty: inv.qty, minLevel: prod.minStockLevel, branchId: inv.branchId });
        }
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
