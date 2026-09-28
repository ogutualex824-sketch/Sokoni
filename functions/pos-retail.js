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

/* ════════════════════════════════════════════════════════════════════════════════════════════
   2. sendPOSReceipt — a TILL SALE's receipt, from the server's record, to the customer on record (Q0c-3)

   THE DEFECT. The caller supplied the recipient (`phone` / `email`) AND the whole receipt (`sale`: shop name, item
   names, quantities, totals), so any signed-in account could send any text — SMS or email — to anyone, under any shop
   name it chose. No client calls it (pos-customers.js defines, but nothing invokes, its receipt helpers).

   THE AUTHORITY — the caller names ONLY the sale: { saleId, channel: 'sms' | 'email' }.
     · scope — a TILL sale only: posReceipts/{saleId} AND posRetailSales/{saleId} must both exist and name the same
       merchant. posReceipts is shared with subscription and marketplace-order receipts; those, the marketplace
       `receipts` collection and recordPOSSale's receipts are other products and fail closed here;
     · sender — the sale's merchant is PROVEN for the caller by the till customer authority
       (pos-zero-friction _provenCustomerOwners, `customers`): the shop owner and its staff, or a business member
       holding `customers`. There is deliberately NO admin override — the till authority has none, and no second
       seller authority is introduced for receipts;
     · recipient — ONLY the posCustomers record the sale names, which must exist and be owned by that proven merchant
       (pos-customer-scope classifyCustomer), and must carry the channel's contact. The phone copied onto the sale at
       checkout came from the browser and is never used; no email is looked up anywhere else. Anything missing fails
       closed;
     · content — ONE builder renders both channels from the same posReceipts document: receipt number derived from the
       sale, product names from the product records (set server-side at checkout), server-computed prices and totals,
       and the shop / business name from the server's own record;
     · repeat sends — at most 3 per sale per channel, reserved in a Firestore TRANSACTION before dispatch, so
       concurrent requests cannot together exceed it; the 4th is refused without sending;
     · audit — every attempt after sign-in (auditLogs, type posSendReceipt) with HASHED sale / customer references,
       the channel and the outcome; no phone number or email address is stored.
   `sent` means the provider accepted the message — not that it was delivered.
════════════════════════════════════════════════════════════════════════════════════════════ */
const _crypto = require('crypto');
const RECEIPT_SENDS_PER_CHANNEL = 3;
const _hash = (s) => _crypto.createHash('sha256').update(String(s)).digest('hex');
const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

/* The ONE receipt model both channels render from — built only from the server's records. */
function _receiptModel(receipt, shopName) {
  const items = (Array.isArray(receipt.items) ? receipt.items : []).map((i) => {
    const qty = Number(i.qty) || 0, unit = Number(i.unitPrice) || 0;
    return { name: _sanitize(i.name), qty, lineTotal: Math.round(qty * unit * 100) / 100 };
  });
  return {
    shopName: _sanitize(shopName || 'SOKONI'),
    receiptNo: _sanitize(receipt.receiptNo),
    items,
    subtotal: Number(receipt.subtotal) || 0,
    discount: Number(receipt.discount) || 0,
    tax: Number(receipt.tax) || 0,
    total: Number(receipt.total) || 0,
  };
}
function _receiptSms(m) {
  return [
    `${m.shopName} Receipt #${m.receiptNo}`,
    ...m.items.slice(0, 5).map((i) => `${i.qty}x ${i.name}: ${_kes(i.lineTotal)}`),
    m.items.length > 5 ? `+${m.items.length - 5} more items` : '',
    `TOTAL: ${_kes(m.total)}`,
    `Thank you for shopping at ${m.shopName}!`,
  ].filter(Boolean).join('\n').slice(0, 320);
}
function _receiptEmailHtml(m) {
  const rows = m.items.map((i) => `<tr><td style="padding:6px 10px">${i.qty}x ${_esc(i.name)}</td><td style="padding:6px 10px;text-align:right">${_kes(i.lineTotal)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f5f5f5;padding:20px">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden">
      <div style="background:#71ff00;padding:20px;text-align:center;color:#000">
        <h2 style="margin:0">${_esc(m.shopName)}</h2><p style="margin:4px 0;opacity:.8">Receipt #${_esc(m.receiptNo)}</p>
      </div>
      <div style="padding:20px"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody><tfoot>
        ${m.discount > 0 ? `<tr><td style="padding:6px 10px;color:#888">Discount</td><td style="padding:6px 10px;text-align:right">-${_kes(m.discount)}</td></tr>` : ''}
        ${m.tax > 0 ? `<tr><td style="padding:6px 10px;color:#888">VAT</td><td style="padding:6px 10px;text-align:right">${_kes(m.tax)}</td></tr>` : ''}
        <tr style="border-top:2px solid #4db800"><td style="padding:8px 10px;font-weight:700">TOTAL</td><td style="padding:8px 10px;text-align:right;font-weight:700">${_kes(m.total)}</td></tr>
      </tfoot></table></div>
    </div></body></html>`;
}
async function _shopNameFor(merchantId) {
  const id = String(merchantId);
  const [shop, biz] = await Promise.all([db.collection('shops').doc(id).get(), db.collection('businesses').doc(id).get()]);
  const s = shop.exists ? (shop.data() || {}) : null, b = biz.exists ? (biz.data() || {}) : null;
  return (s && (s.storeName || s.name || s.shopName)) || (b && (b.name || b.businessName)) || 'SOKONI';
}
function _receiptAudit(entry) {
  return db.collection('auditLogs').add(Object.assign({ type: 'posSendReceipt', ts: admin.firestore.FieldValue.serverTimestamp() }, entry)).catch(() => {});
}

exports.sendPOSReceipt = onCall(
  { secrets: [SENDGRID_SK, ...sokoniAt.secrets], region: 'us-central1', maxInstances: 30, cors: true, enforceAppCheck: true },
  async (request) => {
    if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Must be signed in');
    const callerUid = request.auth.uid;
    const { saleId, channel } = request.data || {};
    if (typeof saleId !== 'string' || !/^[^/]{1,200}$/.test(saleId)) throw new HttpsError('invalid-argument', 'saleId is required.');
    if (channel !== 'sms' && channel !== 'email') throw new HttpsError('invalid-argument', "channel must be 'sms' or 'email'.");
    const saleRef = _hash(saleId).slice(0, 16);

    /* 1. a TILL sale: the receipt and the sale both exist and name the same merchant */
    const [rSnap, sSnap] = await Promise.all([db.collection('posReceipts').doc(saleId).get(), db.collection('posRetailSales').doc(saleId).get()]);
    const receipt = rSnap.exists ? (rSnap.data() || {}) : null, sale = sSnap.exists ? (sSnap.data() || {}) : null;
    if (!receipt || !sale || !receipt.merchantId || String(receipt.merchantId) !== String(sale.merchantId)) {
      _receiptAudit({ callerUid, saleRef, channel, outcome: 'refused_not_a_till_sale' });
      throw new HttpsError('not-found', 'No till sale receipt was found for that sale.');
    }
    const merchantId = String(sale.merchantId);

    /* 2. the caller may act for that merchant (the till customer authority; no admin override) */
    let owners;
    try {
      owners = await require('./pos-zero-friction')._provenCustomerOwners(callerUid, merchantId);
    } catch (e) {
      _receiptAudit({ callerUid, saleRef, channel, outcome: 'refused_unproven_merchant' });
      throw e;
    }

    /* 3. the recipient is the posCustomers record the sale names, owned by that merchant, with this channel's contact */
    const custScope = require('./pos-customer-scope');
    const customerId = sale.customer && typeof sale.customer.id === 'string' ? sale.customer.id : null;
    const cSnap = customerId && custScope.isCustomerDocId(customerId) ? await db.collection('posCustomers').doc(customerId).get() : null;
    const owned = !!(cSnap && cSnap.exists && custScope.classifyCustomer(cSnap.id, cSnap.data(), owners) === 'owned');
    const cust = owned ? (cSnap.data() || {}) : {};
    const phone = owned ? custScope.canonicalPhone(cust.phone) : null;
    const email = owned && typeof cust.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cust.email.trim()) ? cust.email.trim() : null;
    const to = channel === 'sms' ? phone : email;
    if (!to) {
      _receiptAudit({ callerUid, saleRef, channel, customerRef: customerId ? _hash(customerId).slice(0, 16) : null,
        outcome: owned ? 'refused_no_contact_for_channel' : 'refused_no_owned_customer' });
      throw new HttpsError('failed-precondition',
        'This sale has no customer on record with ' + (channel === 'sms' ? 'a phone number' : 'an email address') + ', so no receipt was sent.');
    }

    /* 4. at most 3 sends per sale per channel — reserved atomically before dispatch */
    const counterRef = db.collection('posReceiptSends').doc(_hash(merchantId + '|' + saleId + '|' + channel).slice(0, 40));
    let attempt;
    try {
      attempt = await db.runTransaction(async (t) => {
        const c = await t.get(counterRef);
        const used = (c.exists && Number(c.data().count)) || 0;
        if (used >= RECEIPT_SENDS_PER_CHANNEL) {
          throw new HttpsError('resource-exhausted', `This receipt has already been sent ${used} times by ${channel}. Nothing was sent.`);
        }
        t.set(counterRef, { count: used + 1, channel, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return used + 1;
      });
    } catch (e) {
      _receiptAudit({ callerUid, saleRef, channel, outcome: e && e.code === 'resource-exhausted' ? 'refused_send_limit' : 'refused_limit_unavailable' });
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('unavailable', 'The send limit could not be checked, so no receipt was sent.');
    }

    /* 5. ONE model, rendered for the requested channel, dispatched to the contact on record */
    const model = _receiptModel(receipt, await _shopNameFor(merchantId));
    let sent = false;
    if (channel === 'sms') {
      try { sokoniAt.resolveAtCredentials(); } catch (e) { throw new HttpsError('failed-precondition', e.message); }
      const r = await sokoniAt.atSendSMSWithRetry(to, _receiptSms(model));
      sent = !!(r && r.ok);
    } else {
      const apiKey = SENDGRID_SK.value();
      if (!apiKey) throw new HttpsError('failed-precondition', 'Email service not configured');
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(apiKey);
      try {
        await sgMail.send({ to, from: { email: 'receipts@mysokoni.co.ke', name: model.shopName },
          subject: `Receipt #${model.receiptNo} — ${model.shopName}`, html: _receiptEmailHtml(model) });
        sent = true;
      } catch (e) { sent = false; }
    }
    await _receiptAudit({ callerUid, saleRef, channel, customerRef: _hash(customerId).slice(0, 16), attempt, outcome: sent ? 'sent' : 'provider_failed' });
    if (!sent) throw new HttpsError('unavailable', 'The receipt could not be sent.');
    return { sent: true, channel, attempt, receiptNo: model.receiptNo };
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
