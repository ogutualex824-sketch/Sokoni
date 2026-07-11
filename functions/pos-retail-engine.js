'use strict';
/**
 * SOKONI SmartPOS 2.1 — Retail Engine Cloud Functions
 *
 * Sections:
 *  A. Customer Engine    — profiles, loyalty, identification
 *  B. Sale Recording     — complete sale lifecycle
 *  C. Receipt Engine     — digital receipts, email, SMS, eTIMS
 *  D. Inventory Intel    — alerts, insights, reorder suggestions
 *  E. POS Analytics      — revenue, products, staff, peak hours
 *  F. Staff Management   — permissions, audit trail, shift reports
 *  G. Multi-Branch       — inventory, transfers, HQ dashboard
 */

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { onSchedule }          = require('firebase-functions/v2/scheduler');
const { defineSecret }        = require('firebase-functions/params');
const admin                   = require('firebase-admin');

const SENDGRID_KEY = defineSecret('SENDGRID_API_KEY');
const { COMPANY }  = require('./company-identity');

exports._h = {}; // handler registry — consumed by smartpos-dispatch.js

const db   = admin.firestore;
const now  = () => admin.firestore.FieldValue.serverTimestamp();
const incr = (n) => admin.firestore.FieldValue.increment(n);
const arrU = (...v) => admin.firestore.FieldValue.arrayUnion(...v);

/* ── Helpers ── */
function _san(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>"'`]/g, '').slice(0, max);
}
function _num(v, def = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}
function _authRequired(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth;
}
function _adminOrSeller(req) {
  const auth   = _authRequired(req);
  const claims = auth.token || {};
  const ok = claims.admin || claims.role === 'admin' || claims.role === 'super_admin'
          || claims.role === 'seller' || claims.sellerVerified;
  if (!ok) throw new HttpsError('permission-denied', 'Seller access required');
  return auth;
}

/* Receipt ID generator */
function _receiptId() {
  const d   = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rnd = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  return `RCP-${ymd}-${rnd}`;
}

/* Round to 2 dp */
function _r2(n) { return Math.round(n * 100) / 100; }

/* Emit platform event (fire-and-forget) */
function _emitEvent(type, payload) {
  return admin.firestore().collection('platformEvents').add({
    type, domain: type.split('.')[0], noun: type.split('.')[1]||'', verb: type.split('.')[2]||'',
    payload, metadata: { publishedAt: now(), publishedBy: 'pos-retail-engine', version: '1.0' },
    delivery: { attempts: 0, lastAttempt: null, subscribers: [], failed: [] },
    status: 'pending', createdAt: now(),
  }).catch(() => {}); /* never fail main flow on event errors */
}

/* ══════════════════════════════════════════════════════════════
   A. CUSTOMER ENGINE
══════════════════════════════════════════════════════════════ */

/* Normalize Kenyan phone to 254XXXXXXXX */
function _normalizePhone(phone) {
  if (!phone) return null;
  const p = String(phone).replace(/\D/g, '');
  if (/^07\d{8}$/.test(p)) return '254' + p.slice(1);
  if (/^01\d{8}$/.test(p)) return '254' + p.slice(1);
  if (/^2547\d{8}$/.test(p)) return p;
  if (/^2541\d{8}$/.test(p)) return p;
  return null;
}

/* Loyalty tier thresholds (cumulative points) */
const TIER = [
  { name: 'Bronze',   min: 0,     emoji: '🥉' },
  { name: 'Silver',   min: 1000,  emoji: '🥈' },
  { name: 'Gold',     min: 5000,  emoji: '🥇' },
  { name: 'Platinum', min: 20000, emoji: '💎' },
];
function _tier(points) {
  for (let i = TIER.length - 1; i >= 0; i--) {
    if (points >= TIER[i].min) return TIER[i];
  }
  return TIER[0];
}
/* 1 point per KES 10 spent */
function _calcPoints(amount) { return Math.floor(amount / 10); }

/**
 * CF: getPOSCustomer — look up by phone or customerId
 * Returns customer profile + loyalty status
 */
exports.getPOSCustomer = onCall({ enforceAppCheck: true }, exports._h.getPOSCustomer = async (req) => {
  _adminOrSeller(request);
  const { phone, customerId } = req.data || {};

  let snap;
  if (customerId) {
    snap = await admin.firestore().collection('posCustomers').doc(_san(customerId, 40)).get();
  } else if (phone) {
    const normalized = _normalizePhone(phone);
    if (!normalized) throw new HttpsError('invalid-argument', 'Invalid phone number');
    const q = await admin.firestore().collection('posCustomers')
      .where('phone', '==', normalized).limit(1).get();
    snap = q.empty ? null : q.docs[0];
  } else {
    throw new HttpsError('invalid-argument', 'phone or customerId required');
  }

  if (!snap || !snap.exists) return { found: false };

  const data = snap.data();
  const tier = _tier(data.loyaltyPoints || 0);
  return { found: true, customer: { ...data, customerId: snap.id, tier } };
});

/**
 * CF: upsertPOSCustomer — create or update customer profile
 */
exports.upsertPOSCustomer = onCall({ enforceAppCheck: true }, exports._h.upsertPOSCustomer = async (req) => {
  _adminOrSeller(request);
  const { customerId, phone, name, email } = req.data || {};

  const normalized = _normalizePhone(phone);
  if (!normalized) throw new HttpsError('invalid-argument', 'Invalid phone number');

  /* Look up existing by phone */
  const existing = await admin.firestore().collection('posCustomers')
    .where('phone', '==', normalized).limit(1).get();

  const docRef = !existing.empty
    ? existing.docs[0].ref
    : (customerId
        ? admin.firestore().collection('posCustomers').doc(_san(customerId, 40))
        : admin.firestore().collection('posCustomers').doc());

  const payload = {
    phone:         normalized,
    name:          name ? _san(name, 100)  : (existing.empty ? 'Guest Customer' : admin.firestore.FieldValue.delete()),
    email:         email ? _san(email, 200) : admin.firestore.FieldValue.delete(),
    updatedAt:     now(),
  };

  if (existing.empty) {
    /* New customer */
    await docRef.set({
      ...payload,
      loyaltyPoints: 0,
      totalSpend:    0,
      visitCount:    0,
      createdAt:     now(),
    });
  } else {
    await docRef.update(payload);
  }

  const snap = await docRef.get();
  const data = snap.data();
  return { customerId: snap.id, customer: { ...data, tier: _tier(data.loyaltyPoints || 0) } };
});

/* ══════════════════════════════════════════════════════════════
   B. SALE RECORDING
══════════════════════════════════════════════════════════════ */

/**
 * CF: recordPOSSale — record a completed POS sale
 * Generates receipt, awards loyalty points, updates inventory
 */
exports.recordPOSSale = onCall({ enforceAppCheck: true }, exports._h.recordPOSSale = async (req) => {
  const auth = _adminOrSeller(request);
  const {
    sellerId, sessionId, branchId,
    items,         /* [{ productId, name, sku, qty, price, cost, discount, taxRate }] */
    payment,       /* { method, ref, amount } */
    customerId, customerPhone,
    cashierName, cashierUid,
    discountTotal,
  } = req.data || {};

  if (!items || !items.length) throw new HttpsError('invalid-argument', 'items required');
  if (!payment || !payment.amount) throw new HttpsError('invalid-argument', 'payment required');

  const fdb = admin.firestore();
  const saleRef = fdb.collection('posSales').doc();
  const saleId  = saleRef.id;
  const receiptId = _receiptId();

  /* Calculate totals */
  let subtotal = 0, costTotal = 0;
  const validatedItems = (items || []).map(item => {
    const qty       = _num(item.qty, 1);
    const price     = _num(item.price, 0);
    const cost      = _num(item.cost, 0);
    const discount  = _num(item.discount, 0);
    const taxRate   = _num(item.taxRate, 16);
    const lineTotal = _r2((price - discount) * qty);
    subtotal   += lineTotal;
    costTotal  += cost * qty;
    return {
      productId: item.productId ? _san(item.productId, 40) : null,
      name:      _san(item.name || 'Product', 200),
      sku:       item.sku ? _san(item.sku, 50) : null,
      qty, price, cost, discount, taxRate, lineTotal,
    };
  });

  const itemDiscount = _r2(_num(discountTotal, 0));
  const taxable      = _r2(subtotal - itemDiscount);
  const avgTaxRate   = 16; /* KES standard VAT — simplification */
  const taxAmount    = _r2(taxable * (avgTaxRate / 116));   /* tax-inclusive */
  const total        = _r2(taxable);
  const profit       = _r2(total - costTotal);

  /* Customer lookup */
  let customer = null, customerDocRef = null;
  if (customerId || customerPhone) {
    const phone = customerPhone ? _normalizePhone(customerPhone) : null;
    if (phone) {
      const q = await fdb.collection('posCustomers').where('phone', '==', phone).limit(1).get();
      if (!q.empty) { customer = q.docs[0].data(); customerDocRef = q.docs[0].ref; }
    } else if (customerId) {
      const snap = await fdb.collection('posCustomers').doc(_san(customerId, 40)).get();
      if (snap.exists) { customer = snap.data(); customerDocRef = snap.ref; }
    }
  }

  const pointsEarned  = _calcPoints(total);
  const pointsTotal   = (customer?.loyaltyPoints || 0) + pointsEarned;
  const tier          = _tier(pointsTotal);

  /* Store info from seller profile */
  const sellerSnap = await fdb.collection('sellers').doc(_san(sellerId || auth.uid, 40)).get();
  const store = sellerSnap.exists ? {
    name:    sellerSnap.data().businessName || sellerSnap.data().name || 'SOKONI Store',
    address: sellerSnap.data().address || '',
    phone:   sellerSnap.data().phone   || '',
    email:   sellerSnap.data().email   || '',
    vatNo:   sellerSnap.data().vatNo   || '',
    logo:    sellerSnap.data().logoUrl || null,
  } : { name: 'SOKONI Store', address: '', phone: '', email: '', vatNo: '', logo: null };

  /* Atomically check and reserve stock for all tracked items BEFORE committing the sale.
     Each product is validated and decremented inside a single runTransaction so that
     concurrent sales cannot both claim the last unit (TOCTOU-safe). */
  const stockItems = validatedItems.filter(i => i.productId);
  if (stockItems.length > 0) {
    await fdb.runTransaction(async t => {
      const refs  = stockItems.map(i => fdb.collection('products').doc(i.productId));
      const snaps = await Promise.all(refs.map(r => t.get(r)));

      for (let i = 0; i < snaps.length; i++) {
        if (!snaps[i].exists) continue;
        const currentStock = snaps[i].data().stock;
        if (typeof currentStock === 'number' && currentStock < stockItems[i].qty) {
          throw new HttpsError('failed-precondition',
            `Insufficient stock for "${stockItems[i].name}": ${currentStock} unit(s) available, ${stockItems[i].qty} requested`);
        }
      }

      for (let i = 0; i < snaps.length; i++) {
        if (!snaps[i].exists) continue;
        t.update(refs[i], {
          stock:      admin.firestore.FieldValue.increment(-stockItems[i].qty),
          soldCount:  admin.firestore.FieldValue.increment(stockItems[i].qty),
          lastSoldAt: now(),
        });
      }
    });
  }

  /* Write sale + receipt in a batch (stock already secured above) */
  const batch = fdb.batch();

  /* Sale record */
  batch.set(saleRef, {
    saleId,
    receiptId,
    sellerId:      sellerId || auth.uid,
    branchId:      branchId ? _san(branchId, 40) : null,
    sessionId:     sessionId ? _san(sessionId, 40) : null,
    cashierUid:    cashierUid || auth.uid,
    cashierName:   cashierName ? _san(cashierName, 100) : 'Unknown',
    customerId:    customer ? (customerDocRef?.id || null) : null,
    customerName:  customer?.name || null,
    customerPhone: customer?.phone || null,
    items:         validatedItems,
    subtotal, itemDiscount, taxAmount, total, profit,
    payment: {
      method: _san(payment.method || 'cash', 20),
      ref:    payment.ref ? _san(payment.ref, 100) : null,
      amount: _num(payment.amount, 0),
    },
    pointsEarned,
    status:    'completed',
    createdAt: now(),
  });

  /* Receipt record */
  const receiptRef = fdb.collection('receipts').doc(receiptId);
  batch.set(receiptRef, {
    receiptId,
    saleId,
    sellerId: sellerId || auth.uid,
    store,
    sale: {
      date:     new Date().toISOString(),
      cashier:  cashierName ? _san(cashierName, 100) : 'Unknown',
      items:    validatedItems,
      subtotal, discount: itemDiscount, tax: taxAmount, total,
    },
    payment: {
      method: _san(payment.method || 'cash', 20),
      ref:    payment.ref ? _san(payment.ref, 100) : null,
      amount: _num(payment.amount, 0),
    },
    customer: customer ? {
      name:         customer.name || 'Guest',
      phone:        customer.phone || null,
      tier:         tier.name,
      pointsEarned, pointsTotal,
    } : null,
    verifyUrl: `https://mysokoni.co.ke/receipt/${receiptId}`,
    createdAt: now(),
  });

  await batch.commit();

  /* Award loyalty points (outside batch — ok if this fails) */
  if (customerDocRef && pointsEarned > 0) {
    await customerDocRef.update({
      loyaltyPoints: incr(pointsEarned),
      totalSpend:    incr(total),
      visitCount:    incr(1),
      lastVisit:     now(),
      savedReceipts: arrU(receiptId),
    }).catch(() => {});
  }

  /* Emit platform event */
  await _emitEvent('pos.checkout.completed', {
    saleId, receiptId, sellerId: sellerId || auth.uid, total, itemCount: validatedItems.length,
    paymentMethod: payment.method, customerId: customer ? customerDocRef?.id : null,
  });

  return {
    saleId,
    receiptId,
    receiptUrl: `https://mysokoni.co.ke/receipt/${receiptId}`,
    total,
    pointsEarned,
    pointsTotal,
    tier: tier.name,
  };
});

/**
 * CF: getPOSSale — retrieve a single sale record
 */
exports.getPOSSale = onCall({ enforceAppCheck: true }, exports._h.getPOSSale = async (req) => {
  _adminOrSeller(request);
  const { saleId } = req.data || {};
  if (!saleId) throw new HttpsError('invalid-argument', 'saleId required');

  const snap = await admin.firestore().collection('posSales').doc(_san(saleId, 40)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Sale not found');

  return snap.data();
});

/**
 * CF: voidPOSSale — void a completed sale (manager permission required)
 */
exports.voidPOSSale = onCall({ enforceAppCheck: true }, exports._h.voidPOSSale = async (req) => {
  const auth   = _authRequired(req);
  const claims = auth.token || {};
  const canVoid = claims.admin || claims.role === 'admin' || claims.posRole === 'manager'
               || claims.posRole === 'supervisor' || claims.posRole === 'owner';
  if (!canVoid) throw new HttpsError('permission-denied', 'Manager permission required to void sales');

  const { saleId, reason } = req.data || {};
  if (!saleId)  throw new HttpsError('invalid-argument', 'saleId required');
  if (!reason)  throw new HttpsError('invalid-argument', 'void reason required');

  const ref  = admin.firestore().collection('posSales').doc(_san(saleId, 40));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Sale not found');
  if (snap.data().status === 'voided') throw new HttpsError('already-exists', 'Sale already voided');

  await ref.update({
    status:      'voided',
    voidReason:  _san(reason, 500),
    voidedBy:    auth.uid,
    voidedAt:    now(),
  });

  /* Restore inventory */
  const items = snap.data().items || [];
  await Promise.all(items.filter(i => i.productId).map(i =>
    admin.firestore().collection('products').doc(i.productId)
      .update({ stock: incr(i.qty), soldCount: incr(-i.qty) }).catch(() => {})
  ));

  /* Audit log */
  await admin.firestore().collection('posAuditLog').add({
    action:    'void_sale',
    saleId,
    reason:    _san(reason, 500),
    actorUid:  auth.uid,
    timestamp: now(),
  });

  await _emitEvent('pos.sale.voided', { saleId, reason: _san(reason, 200), actorUid: auth.uid });
  return { saleId, status: 'voided' };
});

/* ══════════════════════════════════════════════════════════════
   C. RECEIPT ENGINE
══════════════════════════════════════════════════════════════ */

/**
 * CF: getReceipt — public receipt verification (no auth required)
 * Used by mysokoni.co.ke/receipt/{receiptId}
 */
exports.getReceipt = onCall({}, exports._h.getReceipt = async (req) => {
  const { receiptId } = req.data || {};
  if (!receiptId) throw new HttpsError('invalid-argument', 'receiptId required');

  const snap = await admin.firestore().collection('receipts').doc(_san(receiptId, 40)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Receipt not found');

  /* Strip sensitive fields for public access */
  const d = snap.data();
  return {
    receiptId:  d.receiptId,
    store:      { name: d.store?.name, address: d.store?.address },
    sale:       { date: d.sale?.date, items: d.sale?.items, total: d.sale?.total },
    payment:    { method: d.payment?.method },
    verifyUrl:  d.verifyUrl,
    createdAt:  d.createdAt,
    valid:      true,
  };
});

/**
 * CF: emailReceipt — send receipt to customer email via SendGrid
 */
exports.emailReceipt = onCall(
  { enforceAppCheck: true, secrets: [SENDGRID_KEY] },
  exports._h.emailReceipt = async (req) => {
    _authRequired(req);
    const { receiptId, email } = req.data || {};
    if (!receiptId) throw new HttpsError('invalid-argument', 'receiptId required');
    if (!email)     throw new HttpsError('invalid-argument', 'email required');

    const snap = await admin.firestore().collection('receipts').doc(_san(receiptId, 40)).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Receipt not found');

    const r = snap.data();

    const itemRows = (r.sale?.items || []).map(i =>
      `<tr><td>${i.name}</td><td style="text-align:right">x${i.qty}</td><td style="text-align:right">KES ${i.lineTotal?.toFixed(2)}</td></tr>`
    ).join('');

    const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${receiptId}</title></head>
<body style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;color:#111">
  <div style="text-align:center;margin-bottom:20px">
    <h2 style="margin:0">${r.store?.name || 'SOKONI Store'}</h2>
    <p style="color:#666;margin:4px 0">${r.store?.address || ''}</p>
    ${r.store?.vatNo ? `<p style="color:#666;font-size:12px">VAT No: ${r.store.vatNo}</p>` : ''}
  </div>
  <hr>
  <p><strong>Receipt:</strong> ${receiptId}</p>
  <p><strong>Date:</strong> ${new Date(r.sale?.date).toLocaleString('en-KE')}</p>
  <p><strong>Cashier:</strong> ${r.sale?.cashier || '—'}</p>
  <hr>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f5f5f5"><th style="text-align:left;padding:6px">Item</th><th>Qty</th><th>Amount</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <hr>
  <p style="text-align:right">Subtotal: <strong>KES ${r.sale?.subtotal?.toFixed(2)}</strong></p>
  ${r.sale?.discount ? `<p style="text-align:right">Discount: <strong>-KES ${r.sale.discount.toFixed(2)}</strong></p>` : ''}
  <p style="text-align:right">VAT (16%): <strong>KES ${r.sale?.tax?.toFixed(2)}</strong></p>
  <p style="text-align:right;font-size:18px"><strong>TOTAL: KES ${r.sale?.total?.toFixed(2)}</strong></p>
  <hr>
  <p>Payment: <strong>${(r.payment?.method || 'cash').toUpperCase()}</strong></p>
  ${r.customer ? `<p>Loyalty Points: +${r.customer.pointsEarned} (Total: ${r.customer.pointsTotal} — ${r.customer.tier})</p>` : ''}
  <div style="text-align:center;margin-top:20px">
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(r.verifyUrl)}" alt="Receipt QR">
    <p style="font-size:12px;color:#999">Scan to verify: <a href="${r.verifyUrl}">${r.verifyUrl}</a></p>
  </div>
  <hr>
  <p style="text-align:center;color:#999;font-size:12px">Powered by SOKONI • mysokoni.co.ke<br>${COMPANY.operatedBy}</p>
</body></html>`;

    const sgKey = SENDGRID_KEY.value();
    if (!sgKey) throw new HttpsError('unavailable', 'Email service not configured');

    const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: _san(email, 200) }] }],
        from:    { email: 'receipts@mysokoni.co.ke', name: r.store?.name || 'SOKONI' },
        subject: `Your receipt from ${r.store?.name || 'SOKONI'} — ${receiptId}`,
        content: [{ type: 'text/html', value: html }],
      }),
    });

    if (!resp.ok) throw new HttpsError('internal', 'Failed to send email');
    return { sent: true, email: _san(email, 200) };
  }
);

/* ══════════════════════════════════════════════════════════════
   D. INVENTORY INTELLIGENCE
══════════════════════════════════════════════════════════════ */

/**
 * CF: getInventoryAlerts — low stock, expiry, overstock alerts
 */
exports.getInventoryAlerts = onCall({ enforceAppCheck: true }, exports._h.getInventoryAlerts = async (req) => {
  const auth = _adminOrSeller(request);
  const { sellerId, branchId, limit: lim = 50 } = req.data || {};
  const sid = sellerId || auth.uid;

  const fdb = admin.firestore();

  /* Low stock — products where stock <= reorderPoint */
  const [lowStock, expiringSoon, overstock] = await Promise.all([
    fdb.collection('products')
      .where('sellerId', '==', sid)
      .where('stockAlert', '==', true)
      .orderBy('stock', 'asc')
      .limit(lim)
      .get(),

    fdb.collection('products')
      .where('sellerId', '==', sid)
      .where('expiryDate', '>', new Date())
      .where('expiryDate', '<', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))
      .orderBy('expiryDate', 'asc')
      .limit(lim)
      .get(),

    fdb.collection('products')
      .where('sellerId', '==', sid)
      .where('stock', '>', 0)
      .orderBy('stock', 'desc')
      .limit(20)
      .get(),
  ]);

  const formatProduct = d => ({
    productId: d.id,
    name:      d.data().name,
    sku:       d.data().sku,
    stock:     d.data().stock,
    reorderPoint: d.data().reorderPoint || 10,
    expiryDate:   d.data().expiryDate || null,
    category:     d.data().category || null,
  });

  /* Overstock = products with very high stock but low sales velocity */
  const overstockFiltered = overstock.docs
    .filter(d => d.data().stock > (d.data().reorderPoint || 10) * 10)
    .map(formatProduct);

  const alerts = [
    ...lowStock.docs.map(d => ({ level: 'critical', type: 'low_stock',   ...formatProduct(d), message: `Only ${d.data().stock} units remaining` })),
    ...expiringSoon.docs.map(d => {
      const days = Math.ceil((d.data().expiryDate.toDate() - Date.now()) / (1000*60*60*24));
      return { level: days < 7 ? 'critical' : 'warning', type: 'expiring', ...formatProduct(d), message: `Expires in ${days} days`, daysLeft: days };
    }),
    ...overstockFiltered.map(d => ({ level: 'info', type: 'overstock', ...d, message: `${d.stock} units — consider a flash sale` })),
  ];

  /* Sort: critical first */
  const levelOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  return { alerts, count: alerts.length };
});

/**
 * CF: getInventoryInsights — fast movers, slow movers, dead stock
 */
exports.getInventoryInsights = onCall({ enforceAppCheck: true }, exports._h.getInventoryInsights = async (req) => {
  const auth = _adminOrSeller(request);
  const { sellerId, days = 30, limit: lim = 20 } = req.data || {};
  const sid = sellerId || auth.uid;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const fdb = admin.firestore();

  /* Top selling products in period */
  const topSales = await fdb.collection('posSales')
    .where('sellerId', '==', sid)
    .where('createdAt', '>', since)
    .where('status', '==', 'completed')
    .limit(500)
    .get();

  /* Aggregate by product */
  const productMap = {};
  topSales.docs.forEach(d => {
    (d.data().items || []).forEach(item => {
      const pid = item.productId || item.name;
      if (!productMap[pid]) {
        productMap[pid] = { productId: item.productId, name: item.name, qty: 0, revenue: 0 };
      }
      productMap[pid].qty     += item.qty;
      productMap[pid].revenue += item.lineTotal;
    });
  });

  const sorted = Object.values(productMap).sort((a, b) => b.qty - a.qty);
  const fastMovers = sorted.slice(0, lim).map(p => ({ ...p, insight: 'fast_mover' }));
  const slowMovers = sorted.slice(-lim).reverse()
    .filter(p => p.qty < 3)
    .map(p => ({ ...p, insight: 'slow_mover', recommendation: 'Consider discounting or removing from stock' }));

  /* Dead stock — products with zero sales in the period */
  const allProducts = await fdb.collection('products')
    .where('sellerId', '==', sid)
    .where('stock', '>', 0)
    .limit(200)
    .get();

  const soldProductIds = new Set(Object.values(productMap).map(p => p.productId).filter(Boolean));
  const deadStock = allProducts.docs
    .filter(d => !soldProductIds.has(d.id) && d.data().stock > 0)
    .slice(0, lim)
    .map(d => ({
      productId: d.id,
      name:      d.data().name,
      stock:     d.data().stock,
      insight:   'dead_stock',
      recommendation: 'No sales in ' + days + ' days — consider promotion or removal',
    }));

  return { fastMovers, slowMovers, deadStock, period: `${days} days`, totalSales: topSales.size };
});

/**
 * CF: getReorderSuggestions — AI-powered reorder recommendations
 */
exports.getReorderSuggestions = onCall({ enforceAppCheck: true }, exports._h.getReorderSuggestions = async (req) => {
  const auth = _adminOrSeller(request);
  const { sellerId } = req.data || {};
  const sid = sellerId || auth.uid;
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  /* Get sales velocity from last 30 days */
  const sales = await admin.firestore().collection('posSales')
    .where('sellerId', '==', sid)
    .where('createdAt', '>', since30d)
    .where('status', '==', 'completed')
    .limit(1000)
    .get();

  const velocity = {};
  sales.docs.forEach(d => {
    (d.data().items || []).forEach(item => {
      if (!item.productId) return;
      velocity[item.productId] = (velocity[item.productId] || 0) + item.qty;
    });
  });

  /* Get current stock for products with high velocity */
  const productIds = Object.keys(velocity).slice(0, 50);
  const products = await Promise.all(
    productIds.map(pid => admin.firestore().collection('products').doc(pid).get())
  );

  const suggestions = products
    .filter(snap => snap.exists)
    .map(snap => {
      const p = snap.data();
      const dailyVelocity = (velocity[snap.id] || 0) / 30;
      const daysOfStock   = dailyVelocity > 0 ? Math.floor(p.stock / dailyVelocity) : 999;
      const reorderPoint  = p.reorderPoint || 10;
      const reorderQty    = Math.max(Math.ceil(dailyVelocity * 30), reorderPoint * 2);

      if (daysOfStock > 30) return null; /* plenty of stock */

      return {
        productId:      snap.id,
        name:           p.name,
        currentStock:   p.stock,
        dailyVelocity:  _r2(dailyVelocity),
        daysOfStock,
        reorderQty,
        urgency:        daysOfStock < 7 ? 'urgent' : daysOfStock < 14 ? 'soon' : 'planned',
        supplierName:   p.supplierName || null,
        supplierPhone:  p.supplierPhone || null,
        estimatedCost:  p.cost ? _r2(p.cost * reorderQty) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.daysOfStock - b.daysOfStock);

  return { suggestions, count: suggestions.length };
});

/* ══════════════════════════════════════════════════════════════
   E. POS ANALYTICS
══════════════════════════════════════════════════════════════ */

/**
 * CF: getPOSAnalytics — revenue, profit, transactions for a date range
 */
exports.getPOSAnalytics = onCall({ enforceAppCheck: true }, exports._h.getPOSAnalytics = async (req) => {
  const auth = _adminOrSeller(request);
  const { sellerId, branchId, startDate, endDate, groupBy = 'day' } = req.data || {};
  const sid = sellerId || auth.uid;

  const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end   = endDate   ? new Date(endDate)   : new Date();

  let q = admin.firestore().collection('posSales')
    .where('sellerId', '==', sid)
    .where('status', '==', 'completed')
    .where('createdAt', '>=', start)
    .where('createdAt', '<=', end)
    .orderBy('createdAt', 'asc')
    .limit(2000);

  if (branchId) q = q.where('branchId', '==', _san(branchId, 40));

  const snaps = await q.get();

  let totalRevenue = 0, totalProfit = 0, totalTax = 0, transactionCount = 0;
  const paymentMethodBreakdown = {};
  const hourBreakdown = Array(24).fill(0).map(() => ({ count: 0, revenue: 0 }));
  const dailyMap = {};
  const productMap = {};
  const cashierMap = {};

  snaps.docs.forEach(d => {
    const sale = d.data();
    totalRevenue     += sale.total || 0;
    totalProfit      += sale.profit || 0;
    totalTax         += sale.taxAmount || 0;
    transactionCount += 1;

    /* Payment method */
    const method = sale.payment?.method || 'cash';
    paymentMethodBreakdown[method] = (paymentMethodBreakdown[method] || 0) + (sale.total || 0);

    /* Hourly breakdown */
    const createdAt = sale.createdAt?.toDate ? sale.createdAt.toDate() : new Date();
    const hr = createdAt.getHours();
    hourBreakdown[hr].count   += 1;
    hourBreakdown[hr].revenue += sale.total || 0;

    /* Daily breakdown */
    const dayKey = createdAt.toISOString().slice(0, 10);
    if (!dailyMap[dayKey]) dailyMap[dayKey] = { date: dayKey, revenue: 0, profit: 0, transactions: 0 };
    dailyMap[dayKey].revenue      += sale.total || 0;
    dailyMap[dayKey].profit       += sale.profit || 0;
    dailyMap[dayKey].transactions += 1;

    /* Top products */
    (sale.items || []).forEach(item => {
      const key = item.productId || item.name;
      if (!productMap[key]) productMap[key] = { name: item.name, qty: 0, revenue: 0 };
      productMap[key].qty     += item.qty;
      productMap[key].revenue += item.lineTotal || 0;
    });

    /* Cashier performance */
    const cashier = sale.cashierName || sale.cashierUid || 'Unknown';
    if (!cashierMap[cashier]) cashierMap[cashier] = { name: cashier, transactions: 0, revenue: 0 };
    cashierMap[cashier].transactions += 1;
    cashierMap[cashier].revenue      += sale.total || 0;
  });

  const topProducts = Object.values(productMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map(p => ({ ...p, revenue: _r2(p.revenue) }));

  const staffPerformance = Object.values(cashierMap)
    .sort((a, b) => b.revenue - a.revenue)
    .map(c => ({ ...c, revenue: _r2(c.revenue), avgSale: _r2(c.revenue / (c.transactions || 1)) }));

  const peakHour = hourBreakdown.reduce((best, h, i) =>
    h.count > (hourBreakdown[best]?.count || 0) ? i : best, 0);

  return {
    summary: {
      totalRevenue:     _r2(totalRevenue),
      totalProfit:      _r2(totalProfit),
      totalTax:         _r2(totalTax),
      transactionCount,
      avgSale:          _r2(totalRevenue / (transactionCount || 1)),
      profitMargin:     _r2(totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0),
    },
    daily:              Object.values(dailyMap).map(d => ({ ...d, revenue: _r2(d.revenue), profit: _r2(d.profit) })),
    topProducts,
    staffPerformance,
    paymentBreakdown:   Object.entries(paymentMethodBreakdown).map(([method, amount]) => ({ method, amount: _r2(amount) })),
    peakHours: {
      data:     hourBreakdown.map((h, i) => ({ hour: i, ...h, revenue: _r2(h.revenue) })),
      peakHour, peakLabel: `${peakHour}:00–${peakHour+1}:00`,
    },
    period: { start: start.toISOString(), end: end.toISOString() },
  };
});

/**
 * CF: getLivePOSMetrics — today's real-time metrics (Redis-first, Firestore fallback)
 */
exports.getLivePOSMetrics = onCall({ enforceAppCheck: true }, exports._h.getLivePOSMetrics = async (req) => {
  const auth = _adminOrSeller(request);
  const { sellerId } = req.data || {};
  const sid = sellerId || auth.uid;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const snaps = await admin.firestore().collection('posSales')
    .where('sellerId', '==', sid)
    .where('status',   '==', 'completed')
    .where('createdAt', '>=', todayStart)
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();

  let revenue = 0, transactions = 0, profit = 0;
  const methods = {};

  snaps.docs.forEach(d => {
    const s = d.data();
    revenue      += s.total || 0;
    profit       += s.profit || 0;
    transactions += 1;
    const m = s.payment?.method || 'cash';
    methods[m]   = (methods[m] || 0) + 1;
  });

  /* Last 5 sales for the live feed */
  const recentSales = snaps.docs.slice(0, 5).map(d => ({
    saleId:     d.data().saleId,
    total:      d.data().total,
    method:     d.data().payment?.method || 'cash',
    cashier:    d.data().cashierName || 'Unknown',
    createdAt:  d.data().createdAt,
    itemCount:  (d.data().items || []).length,
  }));

  return {
    today: {
      revenue:      _r2(revenue),
      profit:       _r2(profit),
      transactions,
      avgSale:      _r2(revenue / (transactions || 1)),
      paymentMethods: methods,
    },
    recentSales,
    timestamp: new Date().toISOString(),
  };
});

/* ══════════════════════════════════════════════════════════════
   F. STAFF MANAGEMENT
══════════════════════════════════════════════════════════════ */

/* Permission matrix */
const PERMISSIONS = {
  cashier:    { discount_max: 5, void_sale: false, cash_drawer: true,  refund: false, manage_inventory: false, view_reports: false, manage_staff: false },
  supervisor: { discount_max: 15, void_sale: true, cash_drawer: true,  refund: true,  manage_inventory: true,  view_reports: true,  manage_staff: false },
  manager:    { discount_max: 30, void_sale: true, cash_drawer: true,  refund: true,  manage_inventory: true,  view_reports: true,  manage_staff: true  },
  owner:      { discount_max: 100,void_sale: true, cash_drawer: true,  refund: true,  manage_inventory: true,  view_reports: true,  manage_staff: true  },
};

/**
 * CF: getStaffPermissions — return the permission set for a role
 */
exports.getStaffPermissions = onCall({ enforceAppCheck: true }, exports._h.getStaffPermissions = async (req) => {
  _authRequired(req);
  const { role } = req.data || {};
  const r = _san(role || 'cashier', 20).toLowerCase();
  return { role: r, permissions: PERMISSIONS[r] || PERMISSIONS.cashier };
});

/**
 * CF: recordAuditEvent — log sensitive POS action
 */
exports.recordAuditEvent = onCall({ enforceAppCheck: true }, exports._h.recordAuditEvent = async (req) => {
  const auth = _authRequired(req);
  const { action, details, saleId, targetUid } = req.data || {};
  if (!action) throw new HttpsError('invalid-argument', 'action required');

  await admin.firestore().collection('posAuditLog').add({
    action:    _san(action, 100),
    details:   details || {},
    saleId:    saleId    ? _san(saleId, 40)    : null,
    targetUid: targetUid ? _san(targetUid, 40) : null,
    actorUid:  auth.uid,
    timestamp: now(),
  });

  return { logged: true };
});

/**
 * CF: getAuditLog — retrieve audit trail (manager+ only)
 */
exports.getAuditLog = onCall({ enforceAppCheck: true }, exports._h.getAuditLog = async (req) => {
  const auth   = _authRequired(req);
  const claims = auth.token || {};
  const canView = claims.admin || claims.posRole === 'manager'
               || claims.posRole === 'owner'  || claims.role === 'admin';
  if (!canView) throw new HttpsError('permission-denied', 'Manager access required');

  const { sellerId, limit: lim = 50, startAfter } = req.data || {};
  let q = admin.firestore().collection('posAuditLog')
    .orderBy('timestamp', 'desc')
    .limit(Math.min(lim, 200));

  const snaps = await q.get();
  return { events: snaps.docs.map(d => ({ id: d.id, ...d.data() })), count: snaps.size };
});

/**
 * CF: getShiftSummary — end-of-shift report for cashier
 */
exports.getShiftSummary = onCall({ enforceAppCheck: true }, exports._h.getShiftSummary = async (req) => {
  const auth = _authRequired(req);
  const { cashierUid, shiftStart, shiftEnd } = req.data || {};
  const uid   = cashierUid || auth.uid;
  const start = shiftStart ? new Date(shiftStart) : (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
  const end   = shiftEnd   ? new Date(shiftEnd)   : new Date();

  const snaps = await admin.firestore().collection('posSales')
    .where('cashierUid', '==', uid)
    .where('status', '==', 'completed')
    .where('createdAt', '>=', start)
    .where('createdAt', '<=', end)
    .limit(500)
    .get();

  let revenue = 0, transactions = 0, voids = 0;
  const paymentSummary = {};

  snaps.docs.forEach(d => {
    const s = d.data();
    revenue += s.total || 0;
    transactions += 1;
    const m = s.payment?.method || 'cash';
    paymentSummary[m] = (paymentSummary[m] || 0) + (s.total || 0);
  });

  return {
    cashierUid: uid,
    shift: { start: start.toISOString(), end: end.toISOString() },
    summary: {
      revenue:      _r2(revenue),
      transactions,
      voids,
      avgSale:      _r2(revenue / (transactions || 1)),
      paymentSummary,
    },
  };
});

/* ══════════════════════════════════════════════════════════════
   G. MULTI-BRANCH
══════════════════════════════════════════════════════════════ */

/**
 * CF: getBranchComparison — HQ cross-branch revenue comparison
 */
exports.getBranchComparison = onCall({ enforceAppCheck: true }, exports._h.getBranchComparison = async (req) => {
  const auth   = _authRequired(req);
  const claims = auth.token || {};
  const isAdmin = claims.admin || claims.role === 'admin' || claims.posRole === 'owner';
  if (!isAdmin) throw new HttpsError('permission-denied', 'Owner access required');

  const { sellerId, days = 30 } = req.data || {};
  const sid   = sellerId || auth.uid;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  /* Get all branches for this seller */
  const branchSnaps = await admin.firestore().collection('branches')
    .where('sellerId', '==', sid).get();

  const branchMap = {};
  branchSnaps.docs.forEach(d => {
    branchMap[d.id] = { branchId: d.id, name: d.data().name, revenue: 0, transactions: 0, profit: 0 };
  });

  /* Aggregate sales by branch */
  const salesSnaps = await admin.firestore().collection('posSales')
    .where('sellerId', '==', sid)
    .where('status', '==', 'completed')
    .where('createdAt', '>=', since)
    .limit(5000)
    .get();

  salesSnaps.docs.forEach(d => {
    const s = d.data();
    const bid = s.branchId || 'main';
    if (!branchMap[bid]) branchMap[bid] = { branchId: bid, name: 'Main Branch', revenue: 0, transactions: 0, profit: 0 };
    branchMap[bid].revenue      += s.total  || 0;
    branchMap[bid].transactions += 1;
    branchMap[bid].profit       += s.profit || 0;
  });

  const branches = Object.values(branchMap)
    .map(b => ({ ...b, revenue: _r2(b.revenue), profit: _r2(b.profit), avgSale: _r2(b.revenue / (b.transactions || 1)) }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    branches,
    totalRevenue:     _r2(branches.reduce((s, b) => s + b.revenue, 0)),
    totalTransactions: branches.reduce((s, b) => s + b.transactions, 0),
    period: `${days} days`,
  };
});

/**
 * CF: initiateInventoryTransfer — request stock transfer between branches
 */
exports.initiateInventoryTransfer = onCall({ enforceAppCheck: true }, exports._h.initiateInventoryTransfer = async (req) => {
  const auth = _authRequired(req);
  const { fromBranchId, toBranchId, items, sellerId } = req.data || {};

  if (!fromBranchId || !toBranchId) throw new HttpsError('invalid-argument', 'fromBranchId and toBranchId required');
  if (!items || !items.length)       throw new HttpsError('invalid-argument', 'items required');

  const transferRef = admin.firestore().collection('inventoryTransfers').doc();
  const transferId  = transferRef.id;

  await transferRef.set({
    transferId,
    sellerId:     sellerId || auth.uid,
    fromBranchId: _san(fromBranchId, 40),
    toBranchId:   _san(toBranchId, 40),
    items:        items.map(i => ({
      productId: _san(i.productId || '', 40),
      name:      _san(i.name || '', 200),
      qty:       _num(i.qty, 1),
    })),
    status:       'pending',
    initiatedBy:  auth.uid,
    createdAt:    now(),
    updatedAt:    now(),
  });

  await _emitEvent('inventory.transfer.initiated', { transferId, fromBranchId, toBranchId, sellerId: sellerId || auth.uid });
  return { transferId, status: 'pending' };
});

/* ══════════════════════════════════════════════════════════════
   SCHEDULED: inventory alert sweep — flag low-stock products
══════════════════════════════════════════════════════════════ */
exports.inventoryAlertSweep = onSchedule(
  { schedule: 'every 6 hours', timeZone: 'Africa/Nairobi' },
  async () => {
    const fdb  = admin.firestore();

    /* Find products where stock <= reorderPoint but not already flagged */
    const products = await fdb.collection('products')
      .where('stock', '>', 0)
      .where('stockAlert', '==', false)
      .limit(500)
      .get();

    const batch  = fdb.batch();
    let flagged  = 0;

    products.docs.forEach(d => {
      const p = d.data();
      const reorderPoint = p.reorderPoint || 10;
      if ((p.stock || 0) <= reorderPoint) {
        batch.update(d.ref, { stockAlert: true });
        flagged++;
      }
    });

    /* Also clear alerts where stock is back above reorder point */
    const alerted = await fdb.collection('products')
      .where('stockAlert', '==', true)
      .limit(500)
      .get();

    alerted.docs.forEach(d => {
      const p = d.data();
      const reorderPoint = p.reorderPoint || 10;
      if ((p.stock || 0) > reorderPoint) {
        batch.update(d.ref, { stockAlert: false });
      }
    });

    await batch.commit();
    console.log(`[InventoryAlertSweep] Flagged: ${flagged}`);
  }
);
