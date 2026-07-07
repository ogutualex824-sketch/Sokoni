/* ================================================================
   SOKONI B2B / Wholesale Commerce Module  v1.0
   functions/b2b-wholesale.js

   Cloud Functions (12):
     1.  createWholesaleAccount   — register a wholesale buyer
     2.  approveWholesaleAccount  — admin: approve + set credit limit
     3.  createWholesaleOrder     — place a bulk order (min 10 units)
     4.  approveWholesaleOrder    — seller/admin: approve & deduct stock
     5.  getWholesaleOrders       — list orders (role-scoped)
     6.  processWholesalePayment  — pay via wallet or credit note
     7.  issueWholesaleCreditNote — admin/seller: issue credit note
     8.  getWholesaleCreditNotes  — list active credit notes
     9.  getWholesaleCatalog      — browse wholesale-enabled products
     10. updateWholesaleProduct   — toggle wholesale flags on a product
     11. getWholesaleAnalytics    — admin: GMV, outstanding, top buyers
     12. getWholesaleAccount      — account detail + ledger tail

   Collections written:
     wholesaleAccounts/{uid}
     wholesaleOrders/{orderId}
     wholesaleLedger/{ledgerId}
     wholesaleCreditNotes/{noteId}
     securityAuditLog/{logId}

   Security posture:
     - Never trust client-supplied prices; all prices read from Firestore
     - Idempotency guard on processWholesalePayment (paidAt field)
     - Role checks at top of every CF
     - KRA PIN regex validated server-side
     - No internal stack traces exposed to callers
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');
const logger                 = require('firebase-functions/logger');

const db = admin.firestore();

/* ── Runtime options ──────────────────────────────────────────── */
const CF_OPTIONS = {
  region:          'us-central1',
  enforceAppCheck: true,
  memory:          '256MiB',
  timeoutSeconds:  60,
};

/* ── Constants ────────────────────────────────────────────────── */
const MAX_CREDIT_LIMIT       = 10_000_000;   // KES
const MAX_CREDIT_NOTE        = 500_000;      // KES
const HIGH_CREDIT_THRESHOLD  = 500_000;      // KES — qualifies for extra discount
const DEFAULT_DISCOUNT_PCT   = 10;           // % applied to all wholesale orders
const HIGH_CREDIT_DISCOUNT   = 25;           // % applied when creditLimit > 500 k
const MIN_ITEM_QTY           = 10;           // minimum units per line item
const MIN_PRODUCT_QTY        = 5;            // minimum for minOrderQty field
const CATALOG_LIMIT          = 100;
const ORDERS_LIMIT           = 50;
const LEDGER_TAIL            = 10;
const TOP_BUYERS_LIMIT       = 5;
const CREDIT_NOTE_TTL_DAYS   = 90;

const VALID_BUSINESS_TYPES  = new Set(['distributor', 'retailer', 'manufacturer']);
const VALID_PAYMENT_TERMS   = new Set(['net7', 'net14', 'net30']);
const KRA_PIN_RE             = /^[A-Z]\d{9}[A-Z]$/;

/* ── Helpers ──────────────────────────────────────────────────── */

/** Throw an HttpsError with a clean message — never leaks stack traces. */
function _err(message, code = 'invalid-argument') {
  throw new HttpsError(code, message);
}

/** Assert the request is authenticated; returns uid. */
function _requireAuth(request) {
  if (!request.auth?.uid) _err('Authentication required.', 'unauthenticated');
  return request.auth.uid;
}

/** Assert caller has at minimum the given numeric role stored in custom claims. */
function _requireRole(request, minRole, label) {
  _requireAuth(request);
  const role = request.auth.token?.role ?? 0;
  if (role < minRole) _err(`${label} access required.`, 'permission-denied');
  return request.auth.uid;
}

/** Assert caller is admin (role >= 4) or has the admin custom claim. */
function _requireAdmin(request) {
  _requireAuth(request);
  const token = request.auth.token;
  const role  = token?.role ?? 0;
  if (role < 4 && !token?.admin && !token?.superAdmin) {
    _err('Admin access required.', 'permission-denied');
  }
  return request.auth.uid;
}

/** Sanitise a plain string: strip HTML tags, trim, cap length. */
function _san(s, max = 300) {
  if (s == null) return '';
  return String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/** Generate a short unique ID with an optional prefix. */
function _genId(prefix = 'doc') {
  const ts   = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

/** Return payment-term days as a number. */
function _termDays(paymentTerms) {
  const map = { net7: 7, net14: 14, net30: 30 };
  return map[paymentTerms] ?? 30;
}

/** Add N days to a Date and return a Firestore Timestamp. */
function _addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return admin.firestore.Timestamp.fromDate(d);
}

/** Write an immutable security audit log entry. */
async function _audit(actorUid, action, targetId, metadata = {}) {
  try {
    await db.collection('securityAuditLog').add({
      actorUid,
      action,
      targetId,
      metadata,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.error('audit_log_failed', { actorUid, action, targetId, error: e.message });
  }
}

/* ════════════════════════════════════════════════════════════════
   1. createWholesaleAccount
   Registers a new wholesale account (status: pending).
   Caller must be a seller (role >= 2) or a buyer applying for
   wholesale access (role >= 1).
════════════════════════════════════════════════════════════════ */
const createWholesaleAccount = onCall(CF_OPTIONS, async (request) => {
  const uid = _requireRole(request, 1, 'Authenticated user');

  const {
    businessName,
    kraPin,
    businessType,
    creditLimitRequested,
    paymentTerms,
  } = request.data || {};

  /* ── Validate inputs ── */
  const name = _san(businessName, 200);
  if (!name) _err('businessName is required.');

  const pin = _san(kraPin, 12).toUpperCase();
  if (!KRA_PIN_RE.test(pin)) {
    _err('Invalid KRA PIN format. Expected format: A123456789B');
  }

  if (!VALID_BUSINESS_TYPES.has(businessType)) {
    _err(`businessType must be one of: ${[...VALID_BUSINESS_TYPES].join(', ')}`);
  }

  if (!VALID_PAYMENT_TERMS.has(paymentTerms)) {
    _err(`paymentTerms must be one of: ${[...VALID_PAYMENT_TERMS].join(', ')}`);
  }

  const requestedLimit = Number(creditLimitRequested) || 50_000;
  if (!Number.isFinite(requestedLimit) || requestedLimit <= 0 || requestedLimit > MAX_CREDIT_LIMIT) {
    _err(`creditLimitRequested must be between 1 and ${MAX_CREDIT_LIMIT} KES.`);
  }

  /* ── Guard against duplicate registration ── */
  const ref    = db.collection('wholesaleAccounts').doc(uid);
  const exists = await ref.get();
  if (exists.exists) {
    _err('A wholesale account for this user already exists.', 'already-exists');
  }

  const account = {
    uid,
    businessName:       name,
    kraPin:             pin,
    businessType,
    creditLimit:        0,            // set by admin on approval
    creditLimitRequested: requestedLimit,
    paymentTerms,
    status:             'pending',
    approvedBy:         null,
    approvedAt:         null,
    createdAt:          admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(account);

  logger.info('wholesale_account_created', { uid, businessType });
  return { success: true, uid, status: 'pending' };
});

/* ════════════════════════════════════════════════════════════════
   2. approveWholesaleAccount
   Admin: approve account, set credit limit, write audit log.
════════════════════════════════════════════════════════════════ */
const approveWholesaleAccount = onCall(CF_OPTIONS, async (request) => {
  const adminUid = _requireAdmin(request);

  const { targetUid, creditLimit } = request.data || {};
  if (!targetUid) _err('targetUid is required.');

  const limit = Number(creditLimit);
  if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_CREDIT_LIMIT) {
    _err(`creditLimit must be between 1 and ${MAX_CREDIT_LIMIT} KES.`);
  }

  const ref  = db.collection('wholesaleAccounts').doc(targetUid);
  const snap = await ref.get();
  if (!snap.exists) _err('Wholesale account not found.', 'not-found');

  const data = snap.data();
  if (data.status === 'approved') {
    _err('Account is already approved.', 'already-exists');
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.update({
    status:      'approved',
    creditLimit: limit,
    approvedBy:  adminUid,
    approvedAt:  now,
  });

  await _audit(adminUid, 'approve_wholesale_account', targetUid, {
    creditLimit: limit,
    previousStatus: data.status,
  });

  logger.info('wholesale_account_approved', { adminUid, targetUid, creditLimit: limit });
  return { success: true, targetUid, creditLimit: limit };
});

/* ════════════════════════════════════════════════════════════════
   3. createWholesaleOrder
   Approved wholesale buyer places a bulk order.
   Prices are ALWAYS read from Firestore — client prices ignored.
════════════════════════════════════════════════════════════════ */
const createWholesaleOrder = onCall(CF_OPTIONS, async (request) => {
  const uid = _requireAuth(request);

  /* ── Verify wholesale account is approved ── */
  const acctSnap = await db.collection('wholesaleAccounts').doc(uid).get();
  if (!acctSnap.exists || acctSnap.data().status !== 'approved') {
    _err('An approved wholesale account is required to place orders.', 'permission-denied');
  }
  const account = acctSnap.data();

  const { items } = request.data || {};
  if (!Array.isArray(items) || items.length === 0) {
    _err('items array is required and must not be empty.');
  }

  /* ── Validate & price each line item from Firestore ── */
  const resolvedItems = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { productId, variantId, quantity } = item || {};

    if (!productId) _err(`items[${i}]: productId is required.`);
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < MIN_ITEM_QTY) {
      _err(`items[${i}]: quantity must be an integer >= ${MIN_ITEM_QTY}.`);
    }

    /* Read authoritative product data from Firestore */
    const prodSnap = await db.collection('products').doc(productId).get();
    if (!prodSnap.exists) _err(`items[${i}]: product '${productId}' not found.`, 'not-found');

    const prod = prodSnap.data();
    if (!prod.wholesaleEnabled) {
      _err(`items[${i}]: product '${productId}' is not enabled for wholesale.`);
    }
    if (typeof prod.wholesalePrice !== 'number' || prod.wholesalePrice <= 0) {
      _err(`items[${i}]: product '${productId}' has no valid wholesale price.`);
    }

    const minQty = prod.minOrderQty ?? MIN_ITEM_QTY;
    if (qty < minQty) {
      _err(`items[${i}]: minimum order quantity for '${productId}' is ${minQty}.`);
    }
    if (prod.maxOrderQty && qty > prod.maxOrderQty) {
      _err(`items[${i}]: maximum order quantity for '${productId}' is ${prod.maxOrderQty}.`);
    }
    if (typeof prod.stock === 'number' && prod.stock < qty) {
      _err(`items[${i}]: insufficient stock for '${productId}' (available: ${prod.stock}).`);
    }

    resolvedItems.push({
      productId,
      variantId:   variantId || null,
      quantity:    qty,
      unitPrice:   prod.wholesalePrice,    // server-authoritative price
      lineTotal:   prod.wholesalePrice * qty,
      productName: _san(prod.name || prod.title || productId, 200),
      sellerId:    prod.sellerId || prod.uid || null,
    });
  }

  /* ── Calculate totals ── */
  const subtotal    = resolvedItems.reduce((s, it) => s + it.lineTotal, 0);
  const discountPct = account.creditLimit > HIGH_CREDIT_THRESHOLD
    ? HIGH_CREDIT_DISCOUNT
    : DEFAULT_DISCOUNT_PCT;
  const discountAmount = Math.round(subtotal * discountPct / 100);
  const total          = subtotal - discountAmount;

  /* ── Credit limit check ── */
  if (total > account.creditLimit) {
    _err(
      `Order total (KES ${total.toLocaleString()}) exceeds your credit limit ` +
      `(KES ${account.creditLimit.toLocaleString()}).`
    );
  }

  /* ── Persist order + ledger entry ── */
  const orderId   = _genId('wo');
  const ledgerId  = _genId('wl');
  const now       = new Date();
  const dueDate   = _addDays(now, _termDays(account.paymentTerms));

  const order = {
    orderId,
    buyerUid:       uid,
    businessName:   account.businessName,
    items:          resolvedItems,
    subtotal,
    discountPct,
    discountAmount,
    total,
    paymentTerms:   account.paymentTerms,
    dueDate,
    status:         'pending',
    paidAt:         null,
    approvedAt:     null,
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
  };

  const batch = db.batch();
  batch.set(db.collection('wholesaleOrders').doc(orderId), order);
  batch.set(db.collection('wholesaleLedger').doc(ledgerId), {
    ledgerId,
    orderId,
    buyerUid:  uid,
    type:      'order',
    amount:    total,
    balance:   total,       // outstanding; updated when paid
    status:    'outstanding',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();

  logger.info('wholesale_order_created', { uid, orderId, total, discountPct });
  return {
    success: true,
    orderId,
    subtotal,
    discountPct,
    discountAmount,
    total,
    dueDate: dueDate.toDate().toISOString(),
    paymentTerms: account.paymentTerms,
  };
});

/* ════════════════════════════════════════════════════════════════
   4. approveWholesaleOrder
   Seller (owns products) or admin approves the order and
   deducts inventory atomically.
════════════════════════════════════════════════════════════════ */
const approveWholesaleOrder = onCall(CF_OPTIONS, async (request) => {
  const uid   = _requireAuth(request);
  const token = request.auth.token;
  const role  = token?.role ?? 0;
  const isAdmin = role >= 4 || !!token?.admin || !!token?.superAdmin;

  const { orderId } = request.data || {};
  if (!orderId) _err('orderId is required.');

  const orderRef  = db.collection('wholesaleOrders').doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) _err('Order not found.', 'not-found');

  const order = orderSnap.data();
  if (order.status !== 'pending') {
    _err(`Order is already '${order.status}'. Only pending orders can be approved.`);
  }

  /* ── Authorization: admin OR seller who owns ALL items ── */
  if (!isAdmin) {
    const sellerIds = [...new Set(order.items.map(it => it.sellerId).filter(Boolean))];
    if (sellerIds.length !== 1 || sellerIds[0] !== uid) {
      _err('You do not have permission to approve this order.', 'permission-denied');
    }
  }

  /* ── Atomic: approve + deduct inventory ── */
  await db.runTransaction(async (tx) => {
    /* Re-read order inside transaction */
    const freshOrder = (await tx.get(orderRef)).data();
    if (freshOrder.status !== 'pending') {
      throw new HttpsError('already-exists', 'Order was already processed by another actor.');
    }

    /* Deduct stock for each line item */
    for (const item of order.items) {
      const prodRef  = db.collection('products').doc(item.productId);
      const prodSnap = await tx.get(prodRef);
      if (!prodSnap.exists) {
        throw new HttpsError('not-found', `Product '${item.productId}' no longer exists.`);
      }
      const currentStock = prodSnap.data().stock ?? 0;
      if (currentStock < item.quantity) {
        throw new HttpsError(
          'resource-exhausted',
          `Insufficient stock for '${item.productId}' (available: ${currentStock}, requested: ${item.quantity}).`
        );
      }
      tx.update(prodRef, {
        stock: admin.firestore.FieldValue.increment(-item.quantity),
      });
    }

    /* Mark order approved */
    tx.update(orderRef, {
      status:     'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: uid,
    });
  });

  logger.info('wholesale_order_approved', { approver: uid, orderId });
  return { success: true, orderId, status: 'approved' };
});

/* ════════════════════════════════════════════════════════════════
   5. getWholesaleOrders
   Buyer  → own orders only
   Seller → orders containing their products (filtered post-fetch)
   Admin  → all orders, optional buyerUid filter
════════════════════════════════════════════════════════════════ */
const getWholesaleOrders = onCall(CF_OPTIONS, async (request) => {
  const uid   = _requireAuth(request);
  const token = request.auth.token;
  const role  = token?.role ?? 0;
  const isAdmin  = role >= 4 || !!token?.admin || !!token?.superAdmin;
  const isSeller = role >= 2;

  const {
    status:    statusFilter,
    buyerUid:  buyerUidFilter,
  } = request.data || {};

  const now = new Date();

  let query = db.collection('wholesaleOrders').orderBy('createdAt', 'desc').limit(ORDERS_LIMIT);

  if (isAdmin) {
    if (buyerUidFilter) query = query.where('buyerUid', '==', buyerUidFilter);
  } else {
    /* Buyers and sellers always scope to their own uid */
    query = query.where('buyerUid', '==', uid);
  }

  if (statusFilter) query = query.where('status', '==', statusFilter);

  const snap   = await query.get();
  let   orders = snap.docs.map(d => {
    const data = d.data();
    const dueDateMs = data.dueDate?.toDate ? data.dueDate.toDate().getTime() : 0;
    return {
      ...data,
      orderId:   d.id,
      isOverdue: dueDateMs > 0 && dueDateMs < now.getTime() && data.status !== 'paid',
      dueDate:   data.dueDate?.toDate ? data.dueDate.toDate().toISOString() : null,
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null,
      approvedAt: data.approvedAt?.toDate ? data.approvedAt.toDate().toISOString() : null,
      paidAt:    data.paidAt?.toDate ? data.paidAt.toDate().toISOString() : null,
    };
  });

  /* Sellers: filter to orders containing their products */
  if (!isAdmin && isSeller) {
    orders = orders.filter(o =>
      Array.isArray(o.items) && o.items.some(it => it.sellerId === uid)
    );
  }

  return { success: true, orders, count: orders.length };
});

/* ════════════════════════════════════════════════════════════════
   6. processWholesalePayment
   Buyer pays an approved wholesale order via:
     - 'wallet'      — deduct from wallets/{uid}.balance
     - 'credit_note' — apply wholesaleCreditNotes/{noteId}
   Idempotency: throws already-exists if order.paidAt is set.
════════════════════════════════════════════════════════════════ */
const processWholesalePayment = onCall(CF_OPTIONS, async (request) => {
  const uid = _requireAuth(request);

  const { orderId, paymentMethod, creditNoteId } = request.data || {};

  if (!orderId)       _err('orderId is required.');
  if (!paymentMethod) _err('paymentMethod is required.');
  if (!['wallet', 'credit_note'].includes(paymentMethod)) {
    _err("paymentMethod must be 'wallet' or 'credit_note'.");
  }
  if (paymentMethod === 'credit_note' && !creditNoteId) {
    _err('creditNoteId is required when paymentMethod is credit_note.');
  }

  const orderRef  = db.collection('wholesaleOrders').doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) _err('Order not found.', 'not-found');

  const order = orderSnap.data();

  /* ── Ownership check ── */
  if (order.buyerUid !== uid) _err('You do not own this order.', 'permission-denied');

  /* ── Idempotency guard ── */
  if (order.paidAt) _err('This order has already been paid.', 'already-exists');

  if (order.status === 'pending') {
    _err('Order must be approved before payment can be processed.');
  }

  await db.runTransaction(async (tx) => {
    /* Re-read for freshness */
    const fresh = (await tx.get(orderRef)).data();
    if (fresh.paidAt) {
      throw new HttpsError('already-exists', 'This order has already been paid.');
    }

    if (paymentMethod === 'wallet') {
      const walletRef  = db.collection('wallets').doc(uid);
      const walletSnap = await tx.get(walletRef);
      if (!walletSnap.exists) {
        throw new HttpsError('not-found', 'Wallet not found. Please top up your wallet first.');
      }
      const balance = walletSnap.data().balance ?? 0;
      if (balance < order.total) {
        throw new HttpsError(
          'resource-exhausted',
          `Insufficient wallet balance. ` +
          `Available: KES ${balance.toLocaleString()}, ` +
          `Required: KES ${order.total.toLocaleString()}.`
        );
      }
      tx.update(walletRef, {
        balance:     admin.firestore.FieldValue.increment(-order.total),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
      /* Wallet transaction record */
      const wtxRef = db.collection('walletTransactions').doc(_genId('wtx'));
      tx.set(wtxRef, {
        uid,
        type:       'wholesale_payment',
        amount:     -order.total,
        orderId,
        description: `Wholesale order ${orderId}`,
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      });

    } else if (paymentMethod === 'credit_note') {
      const noteRef  = db.collection('wholesaleCreditNotes').doc(creditNoteId);
      const noteSnap = await tx.get(noteRef);
      if (!noteSnap.exists) {
        throw new HttpsError('not-found', 'Credit note not found.');
      }
      const note = noteSnap.data();
      if (note.buyerUid !== uid) {
        throw new HttpsError('permission-denied', 'This credit note does not belong to you.');
      }
      if (note.status !== 'active') {
        throw new HttpsError('failed-precondition', 'Credit note is not active.');
      }
      const expiresAt = note.expiresAt?.toDate ? note.expiresAt.toDate() : null;
      if (expiresAt && expiresAt < new Date()) {
        throw new HttpsError('failed-precondition', 'Credit note has expired.');
      }
      if (note.amount < order.total) {
        throw new HttpsError(
          'resource-exhausted',
          `Credit note value (KES ${note.amount.toLocaleString()}) is less than order total ` +
          `(KES ${order.total.toLocaleString()}).`
        );
      }
      tx.update(noteRef, { status: 'redeemed', redeemedAt: admin.firestore.FieldValue.serverTimestamp(), redeemedFor: orderId });
    }

    /* Mark order paid */
    tx.update(orderRef, {
      status: 'paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentMethod,
      creditNoteId: creditNoteId || null,
    });

    /* Update ledger entry to settled */
    const ledgerQuery = db.collection('wholesaleLedger').where('orderId', '==', orderId).limit(1);
    const ledgerSnap  = await tx.get(ledgerQuery);
    if (!ledgerSnap.empty) {
      tx.update(ledgerSnap.docs[0].ref, {
        status:  'settled',
        balance: 0,
        paidAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

  logger.info('wholesale_payment_processed', { uid, orderId, paymentMethod });
  return { success: true, orderId, status: 'paid' };
});

/* ════════════════════════════════════════════════════════════════
   7. issueWholesaleCreditNote
   Admin or seller issues a credit note to a buyer.
════════════════════════════════════════════════════════════════ */
const issueWholesaleCreditNote = onCall(CF_OPTIONS, async (request) => {
  const uid   = _requireAuth(request);
  const token = request.auth.token;
  const role  = token?.role ?? 0;
  const isAdmin  = role >= 4 || !!token?.admin || !!token?.superAdmin;
  const isSeller = role >= 2;

  if (!isAdmin && !isSeller) {
    _err('Admin or seller access required to issue credit notes.', 'permission-denied');
  }

  const { buyerUid, amount, reason } = request.data || {};

  if (!buyerUid) _err('buyerUid is required.');
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_CREDIT_NOTE) {
    _err(`amount must be between 1 and ${MAX_CREDIT_NOTE} KES.`);
  }
  const cleanReason = _san(reason, 500);
  if (!cleanReason) _err('reason is required.');

  /* Verify buyer has a wholesale account */
  const acctSnap = await db.collection('wholesaleAccounts').doc(buyerUid).get();
  if (!acctSnap.exists) {
    _err('Target buyer does not have a wholesale account.', 'not-found');
  }

  const noteId    = _genId('cn');
  const expiresAt = _addDays(new Date(), CREDIT_NOTE_TTL_DAYS);

  const noteDoc = {
    noteId,
    buyerUid,
    amount:     value,
    reason:     cleanReason,
    issuedBy:   uid,
    expiresAt,
    status:     'active',
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    redeemedAt: null,
    redeemedFor: null,
  };

  await db.collection('wholesaleCreditNotes').doc(noteId).set(noteDoc);

  await _audit(uid, 'issue_credit_note', noteId, { buyerUid, amount: value, reason: cleanReason });

  logger.info('wholesale_credit_note_issued', { issuedBy: uid, buyerUid, amount: value, noteId });
  return { success: true, noteId, amount: value, expiresAt: expiresAt.toDate().toISOString() };
});

/* ════════════════════════════════════════════════════════════════
   8. getWholesaleCreditNotes
   Buyer → own active notes; Admin → all active notes.
════════════════════════════════════════════════════════════════ */
const getWholesaleCreditNotes = onCall(CF_OPTIONS, async (request) => {
  const uid   = _requireAuth(request);
  const token = request.auth.token;
  const role  = token?.role ?? 0;
  const isAdmin = role >= 4 || !!token?.admin || !!token?.superAdmin;

  const { targetUid } = request.data || {};
  const queryUid = isAdmin && targetUid ? targetUid : uid;

  let query = db.collection('wholesaleCreditNotes').where('status', '==', 'active');
  if (!isAdmin) {
    query = query.where('buyerUid', '==', uid);
  } else if (targetUid) {
    query = query.where('buyerUid', '==', targetUid);
  }

  const snap = await query.get();
  const now  = new Date();

  const notes = snap.docs
    .map(d => {
      const data = d.data();
      const exp  = data.expiresAt?.toDate ? data.expiresAt.toDate() : null;
      return {
        ...data,
        noteId:     d.id,
        isExpired:  exp ? exp < now : false,
        expiresAt:  exp ? exp.toISOString() : null,
        createdAt:  data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null,
      };
    })
    .filter(n => !n.isExpired);   // exclude silently expired notes

  return { success: true, notes, count: notes.length };
});

/* ════════════════════════════════════════════════════════════════
   9. getWholesaleCatalog
   Approved wholesale accounts: browse wholesale-enabled products.
════════════════════════════════════════════════════════════════ */
const getWholesaleCatalog = onCall(CF_OPTIONS, async (request) => {
  const uid = _requireAuth(request);

  /* Verify approved wholesale account */
  const acctSnap = await db.collection('wholesaleAccounts').doc(uid).get();
  if (!acctSnap.exists || acctSnap.data().status !== 'approved') {
    _err('An approved wholesale account is required to view the wholesale catalog.', 'permission-denied');
  }

  const { category, lastDocId } = request.data || {};

  let query = db.collection('products')
    .where('wholesaleEnabled', '==', true)
    .where('stock', '>', 0)
    .limit(CATALOG_LIMIT);

  if (category) query = query.where('category', '==', category);

  /* Cursor-based pagination */
  if (lastDocId) {
    const lastSnap = await db.collection('products').doc(lastDocId).get();
    if (lastSnap.exists) query = query.startAfter(lastSnap);
  }

  const snap     = await query.get();
  const products = snap.docs.map(d => {
    const data = d.data();
    return {
      productId:    d.id,
      name:         data.name || data.title || '',
      category:     data.category || '',
      retailPrice:  data.price || 0,
      wholesalePrice: data.wholesalePrice || 0,
      minOrderQty:  data.minOrderQty || MIN_ITEM_QTY,
      maxOrderQty:  data.maxOrderQty || null,
      stock:        data.stock || 0,
      sellerId:     data.sellerId || data.uid || null,
      imageUrl:     data.imageUrl || data.image || null,
      description:  _san(data.description || '', 500),
    };
  });

  return { success: true, products, count: products.length };
});

/* ════════════════════════════════════════════════════════════════
   10. updateWholesaleProduct
   Seller (own product) or admin: toggle wholesale settings.
   wholesalePrice MUST be < retail price.
   minOrderQty MUST be >= 5.
════════════════════════════════════════════════════════════════ */
const updateWholesaleProduct = onCall(CF_OPTIONS, async (request) => {
  const uid   = _requireAuth(request);
  const token = request.auth.token;
  const role  = token?.role ?? 0;
  const isAdmin = role >= 4 || !!token?.admin || !!token?.superAdmin;

  const {
    productId,
    wholesaleEnabled,
    wholesalePrice,
    minOrderQty,
    maxOrderQty,
  } = request.data || {};

  if (!productId) _err('productId is required.');

  const prodRef  = db.collection('products').doc(productId);
  const prodSnap = await prodRef.get();
  if (!prodSnap.exists) _err('Product not found.', 'not-found');

  const prod = prodSnap.data();

  /* ── Seller ownership or admin ── */
  if (!isAdmin && prod.sellerId !== uid && prod.uid !== uid) {
    _err('You do not own this product.', 'permission-denied');
  }

  const updates = {};

  if (typeof wholesaleEnabled === 'boolean') {
    updates.wholesaleEnabled = wholesaleEnabled;
  }

  if (wholesalePrice !== undefined) {
    const wp = Number(wholesalePrice);
    if (!Number.isFinite(wp) || wp <= 0) {
      _err('wholesalePrice must be a positive number.');
    }
    const retailPrice = prod.price || prod.retailPrice || 0;
    if (retailPrice > 0 && wp >= retailPrice) {
      _err(`wholesalePrice (${wp}) must be less than retail price (${retailPrice}).`);
    }
    updates.wholesalePrice = wp;
  }

  if (minOrderQty !== undefined) {
    const moq = Number(minOrderQty);
    if (!Number.isInteger(moq) || moq < MIN_PRODUCT_QTY) {
      _err(`minOrderQty must be an integer >= ${MIN_PRODUCT_QTY}.`);
    }
    updates.minOrderQty = moq;
  }

  if (maxOrderQty !== undefined) {
    if (maxOrderQty === null) {
      updates.maxOrderQty = null;
    } else {
      const xoq = Number(maxOrderQty);
      if (!Number.isInteger(xoq) || xoq <= 0) {
        _err('maxOrderQty must be a positive integer or null.');
      }
      const minQ = updates.minOrderQty ?? prod.minOrderQty ?? MIN_PRODUCT_QTY;
      if (xoq < minQ) {
        _err(`maxOrderQty (${xoq}) cannot be less than minOrderQty (${minQ}).`);
      }
      updates.maxOrderQty = xoq;
    }
  }

  if (Object.keys(updates).length === 0) {
    _err('No valid wholesale fields provided to update.');
  }

  updates.wholesaleUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
  updates.wholesaleUpdatedBy = uid;

  await prodRef.update(updates);

  logger.info('wholesale_product_updated', { uid, productId, updates: Object.keys(updates) });
  return { success: true, productId, updatedFields: Object.keys(updates) };
});

/* ════════════════════════════════════════════════════════════════
   11. getWholesaleAnalytics
   Admin: aggregated metrics across all wholesale orders.
════════════════════════════════════════════════════════════════ */
const getWholesaleAnalytics = onCall(CF_OPTIONS, async (request) => {
  _requireAdmin(request);

  const now   = new Date();
  const snap  = await db.collection('wholesaleOrders').orderBy('createdAt', 'desc').limit(500).get();
  const orders = snap.docs.map(d => d.data());

  let totalOrders    = 0;
  let totalGMV       = 0;
  let totalPaid      = 0;
  let totalOutstanding = 0;
  let overdueCount   = 0;
  const buyerGMV     = {};   // { uid: total }

  for (const o of orders) {
    totalOrders++;
    totalGMV += o.total || 0;

    if (o.status === 'paid') {
      totalPaid += o.total || 0;
    } else {
      totalOutstanding += o.total || 0;
      /* Overdue check */
      const dueDateMs = o.dueDate?.toDate ? o.dueDate.toDate().getTime() : 0;
      if (dueDateMs > 0 && dueDateMs < now.getTime()) {
        overdueCount++;
      }
    }

    /* Accumulate buyer GMV */
    if (o.buyerUid) {
      buyerGMV[o.buyerUid] = (buyerGMV[o.buyerUid] || 0) + (o.total || 0);
    }
  }

  /* Top 5 buyers by GMV */
  const topBuyers = Object.entries(buyerGMV)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_BUYERS_LIMIT)
    .map(([buyerUid, gmv]) => ({ buyerUid, gmv }));

  return {
    success: true,
    analytics: {
      totalOrders,
      totalGMV,
      totalPaid,
      totalOutstanding,
      overdueCount,
      topBuyers,
      generatedAt: now.toISOString(),
    },
  };
});

/* ════════════════════════════════════════════════════════════════
   12. getWholesaleAccount
   Owner or admin: fetch account details + recent ledger tail.
════════════════════════════════════════════════════════════════ */
const getWholesaleAccount = onCall(CF_OPTIONS, async (request) => {
  const uid   = _requireAuth(request);
  const token = request.auth.token;
  const role  = token?.role ?? 0;
  const isAdmin = role >= 4 || !!token?.admin || !!token?.superAdmin;

  const { targetUid } = request.data || {};
  const lookupUid = isAdmin && targetUid ? targetUid : uid;

  /* ── Authorization ── */
  if (!isAdmin && lookupUid !== uid) {
    _err('You can only view your own wholesale account.', 'permission-denied');
  }

  const [acctSnap, ledgerSnap] = await Promise.all([
    db.collection('wholesaleAccounts').doc(lookupUid).get(),
    db.collection('wholesaleLedger')
      .where('buyerUid', '==', lookupUid)
      .orderBy('createdAt', 'desc')
      .limit(LEDGER_TAIL)
      .get(),
  ]);

  if (!acctSnap.exists) _err('Wholesale account not found.', 'not-found');

  const account = acctSnap.data();

  /* Compute outstanding balance from unsettled ledger entries */
  const allLedgerSnap = await db.collection('wholesaleLedger')
    .where('buyerUid', '==', lookupUid)
    .where('status', '==', 'outstanding')
    .get();

  const outstandingBalance = allLedgerSnap.docs.reduce((sum, d) => sum + (d.data().balance || 0), 0);

  const recentTransactions = ledgerSnap.docs.map(d => {
    const data = d.data();
    return {
      ...data,
      ledgerId:  d.id,
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null,
      paidAt:    data.paidAt?.toDate ? data.paidAt.toDate().toISOString() : null,
    };
  });

  return {
    success: true,
    account: {
      ...account,
      createdAt:  account.createdAt?.toDate ? account.createdAt.toDate().toISOString() : null,
      approvedAt: account.approvedAt?.toDate ? account.approvedAt.toDate().toISOString() : null,
    },
    outstandingBalance,
    recentTransactions,
  };
});

/* ════════════════════════════════════════════════════════════════
   Module Exports
════════════════════════════════════════════════════════════════ */
module.exports = {
  createWholesaleAccount,
  approveWholesaleAccount,
  createWholesaleOrder,
  approveWholesaleOrder,
  getWholesaleOrders,
  processWholesalePayment,
  issueWholesaleCreditNote,
  getWholesaleCreditNotes,
  getWholesaleCatalog,
  updateWholesaleProduct,
  getWholesaleAnalytics,
  getWholesaleAccount,
};
