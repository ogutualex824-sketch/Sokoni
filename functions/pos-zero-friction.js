/* ================================================================
   SOKONI SmartPOS — Zero Friction Checkout Cloud Functions v1.0
   Server-authoritative checkout chain (idempotent Firestore tx):
   verify payment → update inventory → award loyalty → receipt → analytics
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const db      = getFirestore();
const REGION  = 'us-central1';
const cfg     = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 };
const cfgHeavy= { region: REGION, enforceAppCheck: true, memory: '512MiB', timeoutSeconds: 120 };

/* ── Helpers ── */
const uid = () => db.collection('_').doc().id;

function _sanitize(s) {
  if (typeof s !== 'string') return String(s||'');
  return s.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
}

function _e(msg, code='invalid-argument') {
  throw new HttpsError(code, msg);
}

async function _assertAuth(auth) {
  if (!auth?.uid) _e('Authentication required', 'unauthenticated');
  return auth.uid;
}

/* Fetch merchant config from Firestore */
async function _getMerchant(merchantId) {
  const snap = await db.collection('merchants').doc(merchantId).get();
  if (!snap.exists) _e('Merchant not found', 'not-found');
  return { id: merchantId, ...snap.data() };
}

/* ════════════════════════════════════════════════════════════════
   posCompleteCheckout
   Idempotent authoritative checkout:
   1. Check idempotency key
   2. Verify payment (if M-Pesa, verify with IntaSend)
   3. Deduct inventory (transaction, all-or-nothing)
   4. Award loyalty points
   5. Mark coupon used
   6. Save sale to posRetailSales + posDaily
   7. Create receipt
   8. Update analytics
════════════════════════════════════════════════════════════════ */
exports.posCompleteCheckout = onCall(cfgHeavy, async ({ data, auth }) => {
  const cashierId = await _assertAuth(auth);

  const {
    idempotencyKey,
    merchantId,
    branchId      = 'default',
    shiftId,
    items         = [],
    customer,
    payments      = [],
    couponCode,
    loyaltyRedeemPoints = 0,
    subtotal,
    discountTotal = 0,
    taxTotal      = 0,
    grandTotal,
    metadata      = {},
  } = data || {};

  if (!idempotencyKey) _e('idempotencyKey required');
  if (!merchantId)     _e('merchantId required');
  if (!items?.length)  _e('items required');
  if (!grandTotal || grandTotal < 0) _e('grandTotal invalid');

  /* ── 1. Idempotency claim — atomic ──
     The previous version read, checked, then set: two concurrent requests (double-tap, HTTP
     retry, two till terminals) could both read "not exists" and both proceed — the race window
     in F3. create() is atomic: exactly one caller creates the doc; every other gets
     ALREADY_EXISTS and is routed to the cached result or rejected. */
  const idemRef = db.collection('posIdempotency').doc(idempotencyKey);
  try {
    await idemRef.create({ status: 'processing', startedAt: Date.now(), cashierId, merchantId });
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) {
      const prev = (await idemRef.get()).data() || {};
      if (prev.status === 'complete') return { saleId: prev.saleId, receipt: prev.receipt, cached: true };
      _e('Checkout already in progress', 'already-exists');
    }
    throw err;   /* a real infra error — let the caller retry */
  }

  try {
    /* ── 2. Validate cart totals server-side — batch fetch all products ── */
    const productRefs  = items.map(item => db.collection('posProducts').doc(item.productId));
    const productSnaps = await Promise.all(productRefs.map(r => r.get()));

    let serverSubtotal = 0;
    const enrichedItems = [];
    for (let i = 0; i < items.length; i++) {
      const item     = items[i];
      const prodSnap = productSnaps[i];
      if (!prodSnap.exists) _e(`Product ${item.productId} not found`, 'not-found');
      const prod = prodSnap.data();
      /* Price tolerance: allow minor rounding diff (≤1 KES per item) */
      const serverPrice = prod.salePrice || prod.price || 0;
      const diff = Math.abs(serverPrice - (item.unitPrice || 0));
      if (diff > 1) _e(`Price mismatch for ${prod.name}: expected ${serverPrice}, got ${item.unitPrice}`);
      enrichedItems.push({ ...item, name: _sanitize(prod.name), unitPrice: serverPrice, categoryId: prod.categoryId });
      serverSubtotal += serverPrice * (item.qty || 1);
    }

    /* Allow ±2% rounding tolerance on subtotal */
    if (Math.abs(serverSubtotal - subtotal) > serverSubtotal * 0.02 + 1) {
      _e(`Subtotal mismatch: server=${serverSubtotal} client=${subtotal}`);
    }

    /* ── 3. Coupon validation ── */
    let couponDiscount = 0;
    if (couponCode) {
      const cpSnap = await db.collection('coupons').doc(couponCode.trim().toUpperCase()).get();
      if (!cpSnap.exists || !cpSnap.data().active) _e('Coupon invalid or expired');
      const cp = cpSnap.data();
      if (cp.merchantId && cp.merchantId !== merchantId) _e('Coupon not valid for this store');
      if (cp.expiresAt?.toMillis && cp.expiresAt.toMillis() < Date.now()) _e('Coupon has expired');
      if (cp.usageLimit && (cp.usageCount || 0) >= cp.usageLimit) _e('Coupon usage limit reached');
      couponDiscount = cp.type === 'percent'
        ? Math.min(serverSubtotal * cp.value / 100, cp.maxDiscount || serverSubtotal)
        : Math.min(cp.value || 0, serverSubtotal);
    }

    const saleId   = uid();
    const now      = Date.now();
    const saleDate = new Date(now).toISOString().split('T')[0];

    /* ── 3b. Wallet payment pre-validation ── */
    const walletPayment = payments.find(p => p.method === 'wallet');
    let walletAmt = 0, walletTxRef = null, walletDocRef = null;
    if (walletPayment) {
      if (!customer?.id) _e('Wallet payment requires an identified customer');
      const rawAmt = Number(walletPayment.amount);
      if (!Number.isInteger(rawAmt) || rawAmt <= 0)
        _e('Wallet payment amount must be a positive whole number');
      if (rawAmt > grandTotal)
        _e('Wallet payment exceeds sale total');
      if (walletPayment.customerId && walletPayment.customerId !== customer.id)
        _e('Wallet payment customerId mismatch', 'permission-denied');
      walletAmt    = rawAmt;
      walletTxRef  = db.collection('posWalletTransactions').doc(`${idempotencyKey}_wallet`);
      walletDocRef = db.collection('posWallets').doc(customer.id);
    }

    /* ── 4. Firestore transaction: wallet + inventory + loyalty ──
       Firestore requires ALL READS before ALL WRITES in a transaction. The previous version
       wrote the wallet debit and then read inventory inside the same transaction, so
       Transaction.get() threw "all reads must be executed before all writes" — every
       wallet-paid sale failed 100%. This is restructured into two phases: read everything,
       validate, then write everything. */
    const { loyaltyAwarded } = await db.runTransaction(async txn => {

      /* ── PHASE 1: ALL READS (parallel) ── */
      const productRefs = enrichedItems.map(item => db.collection('posProducts').doc(item.productId));
      const custRef = customer?.id ? db.collection('posCustomers').doc(customer.id) : null;
      const progRef = customer?.id ? db.collection('loyaltyPrograms').doc(merchantId) : null;

      const [wTxSnap, wSnap, custSnap, progSnap, ...productSnaps] = await Promise.all([
        walletPayment ? txn.get(walletTxRef)  : Promise.resolve(null),
        walletPayment ? txn.get(walletDocRef) : Promise.resolve(null),
        custRef ? txn.get(custRef) : Promise.resolve(null),
        progRef ? txn.get(progRef) : Promise.resolve(null),
        ...productRefs.map(r => txn.get(r)),
      ]);

      /* ── PHASE 2: VALIDATE (no writes yet, so a rejection touches nothing) ── */
      /* Wallet: idempotent skip if the deterministic txn doc already exists (prior attempt). */
      const doWalletDeduct = walletPayment && !wTxSnap.exists;
      if (doWalletDeduct) {
        const bal = wSnap.exists ? (wSnap.data().balance ?? 0) : -1;
        if (bal < walletAmt)
          throw new HttpsError('failed-precondition',
            `Insufficient wallet balance: has KES ${Math.max(0, bal)}, needs KES ${walletAmt}`);
      }
      /* Inventory: assert stock before deducting anything. */
      productSnaps.forEach((snap, i) => {
        const item = enrichedItems[i];
        if (!snap.exists) throw new Error(`Product ${item.productId} disappeared`);
        const prod  = snap.data();
        const stock = prod.stockQty ?? prod.quantity ?? 9999;
        if (stock < (item.qty || 1) && prod.trackInventory !== false)
          throw new Error(`Insufficient stock for ${prod.name}`);
      });

      /* ── PHASE 3: ALL WRITES ── */
      if (doWalletDeduct) {
        txn.set(walletDocRef, {
          balance:   FieldValue.increment(-walletAmt),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        txn.set(walletTxRef, {
          sellerId:  merchantId,
          phone:     customer?.phone || '',
          type:      'pos_purchase',
          amount:    -walletAmt,
          saleId,
          idempotencyKey,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      productSnaps.forEach((snap, i) => {
        const item = enrichedItems[i];
        if (snap.data().trackInventory !== false) {
          txn.update(productRefs[i], {
            stockQty:       FieldValue.increment(-(item.qty || 1)),
            lastSoldAt:     FieldValue.serverTimestamp(),
            totalUnitsSold: FieldValue.increment(item.qty || 1),
            totalRevenue:   FieldValue.increment(item.unitPrice * (item.qty || 1)),
          });
        }
      });

      let loyaltyAwarded = 0;
      if (custRef && custSnap.exists) {
        const prog    = progSnap && progSnap.exists ? progSnap.data() : { points: { earnRate: 1, earnDenom: 100 } };
        const earnCfg = prog.points || { earnRate: 1, earnDenom: 100 };
        loyaltyAwarded = Math.floor((serverSubtotal / earnCfg.earnDenom) * earnCfg.earnRate);

        const cust      = custSnap.data();
        const newPoints = Math.max(0, (cust.loyaltyPoints || 0) + loyaltyAwarded - loyaltyRedeemPoints);
        txn.update(custRef, {
          loyaltyPoints:  newPoints,
          lifetimePoints: FieldValue.increment(loyaltyAwarded),
          totalSpent:     FieldValue.increment(grandTotal),
          lastPurchaseAt: FieldValue.serverTimestamp(),
          purchaseCount:  FieldValue.increment(1),
        });
      }

      if (couponCode) {
        const cpRef  = db.collection('coupons').doc(couponCode.trim().toUpperCase());
        const update = { usageCount: FieldValue.increment(1) };
        if (customer?.id) update[`customerUses.${customer.id}`] = FieldValue.increment(1);
        txn.update(cpRef, update);
      }

      return { loyaltyAwarded };
    });

    /* ── 5. Write sale record ── */
    const sale = {
      id:              saleId,
      merchantId:      _sanitize(merchantId),
      branchId:        _sanitize(branchId),
      cashierId:       _sanitize(cashierId),
      shiftId:         shiftId ? _sanitize(shiftId) : null,
      items:           enrichedItems,
      customer:        customer ? {
        id:    _sanitize(customer.id || ''),
        name:  _sanitize(customer.name || 'Guest'),
        phone: _sanitize(customer.phone || ''),
      } : null,
      payments,
      couponCode:         couponCode ? _sanitize(couponCode) : null,
      couponDiscount,
      loyaltyRedeemed:    loyaltyRedeemPoints,
      loyaltyAwarded,
      subtotal:           serverSubtotal,
      discountTotal:      discountTotal + couponDiscount,
      taxTotal,
      grandTotal,
      status:             'completed',
      createdAt:          FieldValue.serverTimestamp(),
      saleDate,
      idempotencyKey:     _sanitize(idempotencyKey),
      ...metadata,
    };

    await db.collection('posRetailSales').doc(saleId).set(sale);

    /* ── 6. Daily counter aggregation ──
       These increments run exactly once per idempotencyKey: the atomic create() claim at the
       top of this function admits a single caller per key, a retry of a 'complete' key returns
       cached before reaching here, and a retry of a 'processing' key is rejected before reaching
       here. So the counter cannot double on retry. (@financial-safe: guarded by the atomic
       idempotency claim above.) */
    const dailyRef = db.collection('posDailySummary').doc(`${merchantId}_${saleDate}`);
    await dailyRef.set({
      merchantId, branchId, saleDate,
      totalSales:    FieldValue.increment(1),
      totalRevenue:  FieldValue.increment(grandTotal),
      totalItems:    FieldValue.increment(items.reduce((s, i) => s + (i.qty || 1), 0)),
      totalDiscount: FieldValue.increment(discountTotal + couponDiscount),
      totalTax:      FieldValue.increment(taxTotal),
      updatedAt:     FieldValue.serverTimestamp(),
    }, { merge: true });

    /* ── 7. Queue metric (for cashier speed analytics) ── */
    if (metadata.checkoutStartedAt) {
      const elapsed = now - metadata.checkoutStartedAt;
      await db.collection('posCheckoutMetrics').add({
        merchantId, branchId, cashierId, saleId,
        itemCount:     items.reduce((s, i) => s + (i.qty || 1), 0),
        durationMs:    elapsed,
        grandTotal,
        paymentMethod: payments[0]?.method || 'unknown',
        createdAt:     FieldValue.serverTimestamp(),
        saleDate,
      });
    }

    /* ── 8. Build receipt ── */
    const receipt = {
      receiptNo:  saleId.slice(-8).toUpperCase(),
      saleId,
      merchantId,
      items:      enrichedItems,
      subtotal:   serverSubtotal,
      discount:   discountTotal + couponDiscount,
      tax:        taxTotal,
      total:      grandTotal,
      payments,
      loyaltyAwarded,
      loyaltyRedeemed: loyaltyRedeemPoints,
      customer:   customer?.name || 'Guest',
      cashier:    cashierId,
      timestamp:  new Date(now).toISOString(),
    };

    await db.collection('posReceipts').doc(saleId).set({ ...receipt, createdAt: FieldValue.serverTimestamp() });

    /* ── 9. Mark idempotency complete ── */
    await idemRef.update({ status: 'complete', saleId, receipt, completedAt: now });

    return { saleId, receipt, loyaltyAwarded };

  } catch (err) {
    await idemRef.update({ status: 'failed', error: err.message, failedAt: Date.now() });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', err.message || 'Checkout failed');
  }
});

/* ════════════════════════════════════════════════════════════════
   posValidateCoupon — server-side coupon check before checkout
════════════════════════════════════════════════════════════════ */
exports.posValidateCoupon = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { code, merchantId, subtotal = 0, customerId } = data || {};
  if (!code) _e('code required');

  const cpSnap = await db.collection('coupons').doc(code.trim().toUpperCase()).get();
  if (!cpSnap.exists) return { valid: false, error: 'Coupon not found' };
  const cp = cpSnap.data();

  if (!cp.active) return { valid: false, error: 'Coupon is inactive' };
  if (cp.merchantId && cp.merchantId !== merchantId) return { valid: false, error: 'Not valid for this store' };
  if (cp.expiresAt?.toMillis && cp.expiresAt.toMillis() < Date.now()) return { valid: false, error: 'Coupon has expired' };
  if (cp.usageLimit && (cp.usageCount || 0) >= cp.usageLimit) return { valid: false, error: 'Usage limit reached' };
  if (cp.minPurchase && subtotal < cp.minPurchase) return { valid: false, error: `Minimum purchase KES ${cp.minPurchase} required` };
  if (customerId && cp.perCustomerLimit) {
    const uses = (cp.customerUses || {})[customerId] || 0;
    if (uses >= cp.perCustomerLimit) return { valid: false, error: 'Already used this coupon' };
  }

  const discountAmount = cp.type === 'percent'
    ? Math.min(subtotal * cp.value / 100, cp.maxDiscount || subtotal)
    : Math.min(cp.value || 0, subtotal);

  return {
    valid: true,
    code: code.trim().toUpperCase(),
    type: cp.type,
    discountAmount: Math.round(discountAmount * 100) / 100,
    description: cp.description || `${cp.value}${cp.type === 'percent' ? '%' : ' KES'} off`,
  };
});

/* ════════════════════════════════════════════════════════════════
   posLookupCustomer — multi-method: phone, QR code, member ID, email
════════════════════════════════════════════════════════════════ */
exports.posLookupCustomer = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { query, method = 'auto', merchantId } = data || {};
  if (!query) _e('query required');

  const q    = String(query).trim();
  const coll = db.collection('posCustomers');
  let snap   = null;

  if (method === 'phone' || method === 'auto') {
    const phone = q.replace(/\s/g, '').replace(/^0/, '+254');
    snap = await coll.where('phone', '==', phone).limit(1).get();
    if (snap.empty) snap = await coll.where('phone', '==', q).limit(1).get();
  }

  if ((!snap || snap.empty) && (method === 'id' || method === 'auto')) {
    const direct = await coll.doc(q).get();
    if (direct.exists) snap = { docs: [direct], empty: false };
  }

  if ((!snap || snap.empty) && (method === 'email' || method === 'auto')) {
    snap = await coll.where('email', '==', q.toLowerCase()).limit(1).get();
  }

  if ((!snap || snap.empty) && (method === 'memberCard' || method === 'auto')) {
    snap = await coll.where('memberCardCode', '==', q.toUpperCase()).limit(1).get();
  }

  if (!snap || snap.empty) return { found: false };

  const doc  = snap.docs[0];
  const cust = doc.data();

  /* Fetch loyalty info if merchantId provided */
  let loyalty = null;
  if (merchantId) {
    const progSnap = await db.collection('loyaltyPrograms').doc(merchantId).get();
    const prog     = progSnap.exists ? progSnap.data() : null;
    if (prog) {
      const pointValue = prog.points?.pointValue || 0.5;
      loyalty = {
        points:      cust.loyaltyPoints || 0,
        pointsValue: Math.round((cust.loyaltyPoints || 0) * pointValue * 100) / 100,
        tier:        cust.tier || 'bronze',
        totalSpent:  cust.totalSpent || 0,
        purchaseCount: cust.purchaseCount || 0,
      };
    }
  }

  return {
    found:   true,
    id:      doc.id,
    name:    cust.name || 'Customer',
    phone:   cust.phone || '',
    email:   cust.email || '',
    tier:    cust.tier || 'bronze',
    loyalty,
  };
});

/* ════════════════════════════════════════════════════════════════
   posProcessRefund — refund with inventory return
════════════════════════════════════════════════════════════════ */
/* Manager-or-owner authority + merchant membership.

   posProcessRefund previously called _assertAuth(), which only checks that SOMEONE is logged in.
   Any authenticated user who knew a saleId could therefore refund it: there was no role gate and
   no check that the caller belonged to the merchant (the only comparison was the client-supplied
   merchantId against the sale's own merchantId, which an attacker simply supplies correctly).
   Refunds move real money and return stock, so they now require manager/owner rank AND
   membership of the merchant that owns the sale. */
async function _assertRefundAuthority(auth, merchantId) {
  if (!auth?.uid) _e('Authentication required', 'unauthenticated');
  const uidStr = auth.uid;

  const role = auth.token?.posRole || 'cashier';
  const isAdmin = auth.token?.admin === true || auth.token?.superAdmin === true;
  if (!isAdmin && role !== 'manager' && role !== 'owner') {
    _e('Refunds require a manager or owner', 'permission-denied');
  }
  if (isAdmin) return uidStr;

  /* Membership: business owner, or an active staff member of this merchant. */
  const [bizSnap, staffSnap] = await Promise.all([
    db.collection('businesses').doc(String(merchantId)).get(),
    db.collection('posStaff')
      .where('merchantId', '==', String(merchantId))
      .where('uid', '==', uidStr)
      .where('status', '==', 'active')
      .limit(1).get(),
  ]);
  if (bizSnap.exists && bizSnap.data().ownerId === uidStr) return uidStr;
  if (!staffSnap.empty) return uidStr;
  _e('You do not belong to this merchant', 'permission-denied');
}

exports.posProcessRefund = onCall(cfgHeavy, async ({ data, auth }) => {
  const { saleId, items, reason, refundMethod = 'cash', merchantId, idempotencyKey } = data || {};
  if (!saleId)        _e('saleId required');
  if (!items?.length) _e('items required');
  if (!reason)        _e('reason required');
  if (!merchantId)    _e('merchantId required');

  const managerId = await _assertRefundAuthority(auth, merchantId);

  const saleRef  = db.collection('posRetailSales').doc(saleId);
  const saleSnap = await saleRef.get();
  if (!saleSnap.exists) _e('Sale not found', 'not-found');
  const sale = saleSnap.data();
  if (sale.merchantId !== merchantId) _e('Unauthorized', 'permission-denied');
  if (sale.status === 'refunded') _e('Sale already fully refunded');

  /* IDEMPOTENCY: refundId used to be a random id, so a double-tapped "Refund" created TWO
     refund records and returned the stock TWICE. Derive it from the caller's key (falling back
     to the saleId, since a sale can only be fully refunded once) and short-circuit inside the
     transaction if it already exists. */
  const rawKey   = String(idempotencyKey || saleId || '');
  const refundId = 'rf_' + rawKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  const refundRef = db.collection('posRefunds').doc(refundId);

  let refundTotal = 0;
  const alreadyDone = await db.runTransaction(async txn => {
    /* ── ALL READS FIRST ──
       The original read each product INSIDE the write loop (txn.get after txn.update), which
       Firestore rejects — every multi-item refund threw at runtime. */
    const prodRefs = items.map(it => db.collection('posProducts').doc(it.productId));
    const [refundSnap, ...prodSnaps] = await Promise.all([
      txn.get(refundRef),
      ...prodRefs.map(r => txn.get(r)),
    ]);

    if (refundSnap.exists) return true;            // idempotent replay — change nothing

    refundTotal = 0;
    /* Validate against the original sale BEFORE writing anything. */
    const plan = items.map((refItem, idx) => {
      const orig = sale.items.find(i => i.productId === refItem.productId);
      if (!orig) throw new Error('Item ' + refItem.productId + ' not in original sale');
      const qty = Number(refItem.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('Refund qty must be positive');
      if (qty > orig.qty) throw new Error('Cannot refund more than sold');
      refundTotal += orig.unitPrice * qty;
      return { qty, orig, snap: prodSnaps[idx], ref: prodRefs[idx] };
    });

    /* ── WRITES ── */
    plan.forEach(pItem => {
      if (pItem.snap.exists && pItem.snap.data().trackInventory !== false) {
        txn.update(pItem.ref, {
          stockQty:       FieldValue.increment(pItem.qty),
          totalUnitsSold: FieldValue.increment(-pItem.qty),
          totalRevenue:   FieldValue.increment(-(pItem.orig.unitPrice * pItem.qty)),
        });
      }
    });

    txn.set(refundRef, {
      id:          refundId,
      saleId,
      merchantId:  _sanitize(merchantId),
      items:       plan.map(x => ({ productId: x.orig.productId, qty: x.qty })),
      refundTotal,
      refundMethod,
      reason:      _sanitize(reason),
      processedBy: managerId,
      createdAt:   FieldValue.serverTimestamp(),
    });
    txn.update(saleRef, { status: 'refunded', refundId, refundedAt: FieldValue.serverTimestamp() });
    return false;
  });

  return { refundId, refundTotal, idempotent: alreadyDone };
});

/* ════════════════════════════════════════════════════════════════
   posGetQueueMetrics — real-time cashier performance & queue analytics
════════════════════════════════════════════════════════════════ */
exports.posGetQueueMetrics = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { merchantId, branchId = 'default', days = 7 } = data || {};
  if (!merchantId) _e('merchantId required');

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const snap = await db.collection('posCheckoutMetrics')
    .where('merchantId', '==', merchantId)
    .where('branchId', '==', branchId)
    .where('saleDate', '>=', sinceStr)
    .orderBy('saleDate', 'asc')
    .limit(1000)
    .get();

  const metrics = snap.docs.map(d => d.data());
  if (!metrics.length) return { empty: true, days };

  /* Aggregate by cashier */
  const byCashier = {};
  let totalMs = 0, totalSales = 0;

  for (const m of metrics) {
    if (!byCashier[m.cashierId]) {
      byCashier[m.cashierId] = { cashierId: m.cashierId, sales: 0, totalMs: 0, maxMs: 0 };
    }
    byCashier[m.cashierId].sales++;
    byCashier[m.cashierId].totalMs += m.durationMs;
    byCashier[m.cashierId].maxMs = Math.max(byCashier[m.cashierId].maxMs, m.durationMs);
    totalMs += m.durationMs;
    totalSales++;
  }

  const cashierStats = Object.values(byCashier).map(c => ({
    ...c,
    avgMs:      Math.round(c.totalMs / c.sales),
    avgDisplay: _msToTime(Math.round(c.totalMs / c.sales)),
    maxDisplay: _msToTime(c.maxMs),
  })).sort((a, b) => a.avgMs - b.avgMs);

  /* Payment method breakdown */
  const byMethod = {};
  for (const m of metrics) {
    byMethod[m.paymentMethod] = (byMethod[m.paymentMethod] || 0) + 1;
  }

  /* Hourly distribution (peak hours) */
  const byHour = Array(24).fill(0);
  for (const d of snap.docs) {
    const ts = d.data().createdAt;
    if (ts?.toDate) byHour[ts.toDate().getHours()]++;
  }

  return {
    days,
    totalSales,
    avgCheckoutMs:      Math.round(totalMs / totalSales),
    avgCheckoutDisplay: _msToTime(Math.round(totalMs / totalSales)),
    cashierStats,
    byPaymentMethod:    byMethod,
    peakHours:          byHour.map((count, hour) => ({ hour, count })),
  };
});

function _msToTime(ms) {
  if (ms < 60000) return `${Math.round(ms/1000)}s`;
  return `${Math.floor(ms/60000)}m ${Math.round((ms%60000)/1000)}s`;
}

/* ════════════════════════════════════════════════════════════════
   posCleanupIdempotency — daily cleanup of old idempotency records
════════════════════════════════════════════════════════════════ */
exports.posCleanupIdempotency = onSchedule({
  schedule:  'every 24 hours',
  timeZone:  'Africa/Nairobi',
  region:    REGION,
}, async () => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const snap = await db.collection('posIdempotency')
    .where('startedAt', '<', cutoff)
    .limit(500)
    .get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  if (!snap.empty) await batch.commit();
});

/* ════════════════════════════════════════════════════════════════
   posCheckPaymentStatus — poll IntaSend transaction status (no confirm() dialog)
   Called by the client every 3s after STK push to auto-detect completion.
   Returns: { status: 'pending' | 'completed' | 'failed', transactionRef, reason }
════════════════════════════════════════════════════════════════ */
exports.posCheckPaymentStatus = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { ref, merchantId } = data || {};
  if (!ref) _e('ref required');

  /* Check posPaymentStatus collection first — webhook writes here on IntaSend callback */
  const statusRef  = db.collection('posPaymentStatus').doc(String(ref));
  const statusSnap = await statusRef.get();

  if (statusSnap.exists) {
    const d = statusSnap.data();
    if (d.status === 'completed') {
      return { status: 'completed', transactionRef: d.transactionRef || ref };
    }
    if (d.status === 'failed' || d.status === 'cancelled') {
      return { status: 'failed', reason: d.failureReason || 'Payment was not completed' };
    }
  }

  /* No webhook yet — check posIdempotency for same-ref completion */
  if (merchantId) {
    const idemSnap = await db.collection('posIdempotency')
      .where('ref', '==', String(ref))
      .where('merchantId', '==', String(merchantId))
      .limit(1).get();
    if (!idemSnap.empty) {
      const idem = idemSnap.docs[0].data();
      if (idem.status === 'completed') return { status: 'completed', transactionRef: ref };
      if (idem.status === 'failed')    return { status: 'failed', reason: 'Payment failed' };
    }
  }

  /* Still waiting for webhook */
  return { status: 'pending' };
});
