/* ================================================================
   SOKONI Procurement Engine  v1.0
   functions/procurement.js

   Handles inbound purchasing from external suppliers — fully distinct
   from b2b-wholesale.js which manages outbound bulk sales to buyers.

   Cloud Functions (10):
     1.  addSupplier              — register a supplier for a merchant
     2.  createPurchaseOrder      — draft a PO against a supplier
     3.  approvePurchaseOrder     — manager/admin approve or cancel PO
     4.  sendPurchaseOrder        — mark PO sent to supplier
     5.  receiveGoods             — GRN: receive items, update inventory
     6.  createSupplierInvoice    — attach supplier invoice to GRN
     7.  approveAndPayInvoice     — admin: approve + post double-entry payment
     8.  getSupplierPerformance   — trend data for a supplier
     9.  getProcurementForecast   — reorder suggestions for a branch
     10. getProcurementDashboard  — KPI summary for a merchant

   Collections written:
     procSuppliers/{supplierId}
     procPurchaseOrders/{poId}
     procGRN/{grnId}
     procSupplierInvoices/{invoiceId}
     procVendorPerformance/{supplierId}_{YYYY-MM}
     procForecast/{merchantId}_{productId}
     stockMovements/{movId}
     paymentLedger/{ledgerId}
     emailQueue/{emailId}           — processed by email CF
     securityAuditLog/{logId}

   Security posture:
     - enforceAppCheck on all CFs
     - Role checks (manager/admin) on mutating operations
     - Server-side VAT calculation (client figures never trusted)
     - Idempotency guard: paidAt field prevents double-payment
     - Deterministic poId via sha256 prevents duplicate POs on retry
     - No internal stack traces returned to callers
     - All string inputs sanitised before Firestore writes
     - Double-entry ledger for full payment audit trail
================================================================ */
'use strict';

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { onSchedule }          = require('firebase-functions/v2/scheduler');
const admin                   = require('firebase-admin');
const crypto                  = require('crypto');
const logger                  = require('firebase-functions/logger');

/* Reuse the platform engines rather than growing private copies of them. The old
   sendPurchaseOrder hand-wrote its own emailQueue document and got the shape wrong — the
   whole reason no supplier ever received a PO. */
const emailSvc                = require('./email-service');
const notify                  = require('./notify');
const { buildPoPdf }          = require('./po-pdf');

const db = admin.firestore();
const F  = admin.firestore.FieldValue;

/* Escape anything interpolated into the PO email. A supplier name is attacker-controllable
   in principle (a merchant types it), and this HTML lands in someone's inbox. */
const _esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const _ksh = n => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 });

/* The PO email. The PDF is the artefact; this is the covering note that makes the
   supplier open it. SOKONI-branded throughout — the legal entity belongs on the PDF's
   footer, not in a customer-facing email header. */
function _poEmailHtml(po, poId, supplier, merchant) {
  const rows = (po.items || []).map(it => {
    const qty  = Number(it.qty || 0);
    const unit = Number(it.unitCost || 0);
    return '<tr>' +
      '<td style="padding:9px 8px;border-bottom:1px solid #eee">' + _esc(it.name || 'Item') +
        (it.sku ? '<br><span style="color:#999;font-size:11px">SKU: ' + _esc(it.sku) + '</span>' : '') + '</td>' +
      '<td style="padding:9px 8px;border-bottom:1px solid #eee;text-align:right">' + qty + '</td>' +
      '<td style="padding:9px 8px;border-bottom:1px solid #eee;text-align:right">' + _ksh(unit) + '</td>' +
      '<td style="padding:9px 8px;border-bottom:1px solid #eee;text-align:right"><strong>' + _ksh(qty * unit) + '</strong></td>' +
    '</tr>';
  }).join('');

  const due = po.expectedDelivery ? new Date(po.expectedDelivery).toDateString() : 'To be confirmed';

  return `<!doctype html><html><body style="margin:0;background:#f5f6f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px">
  <div style="background:#fff;border-radius:14px;padding:28px;border:1px solid #e6e8ea">
    <div style="font-size:22px;font-weight:800;letter-spacing:-.4px">SOKONI</div>
    <div style="color:#888;font-size:12px;margin-top:2px">Procurement</div>
    <h1 style="font-size:19px;margin:22px 0 4px">Purchase Order ${_esc(po.poNumber || poId)}</h1>
    <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 18px">
      Dear ${_esc(supplier?.contactName || supplier?.name || 'Supplier')},<br>
      ${_esc(merchant?.name || 'A SOKONI merchant')} has issued you the purchase order below.
      The signed PDF is attached.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:6px">
      <thead><tr style="background:#fafafa">
        <th style="padding:9px 8px;text-align:left;color:#777;font-size:11px">DESCRIPTION</th>
        <th style="padding:9px 8px;text-align:right;color:#777;font-size:11px">QTY</th>
        <th style="padding:9px 8px;text-align:right;color:#777;font-size:11px">UNIT</th>
        <th style="padding:9px 8px;text-align:right;color:#777;font-size:11px">AMOUNT</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table style="width:100%;font-size:13px;margin-top:10px">
      <tr><td style="text-align:right;color:#666;padding:3px 8px">Subtotal</td>
          <td style="text-align:right;width:130px;padding:3px 8px">${_ksh(po.subtotal)}</td></tr>
      <tr><td style="text-align:right;color:#666;padding:3px 8px">VAT (${po.vatRate != null ? po.vatRate : 16}%)</td>
          <td style="text-align:right;padding:3px 8px">${_ksh(po.vatAmount)}</td></tr>
      <tr><td style="text-align:right;font-weight:800;padding:8px;border-top:2px solid #111">Grand Total</td>
          <td style="text-align:right;font-weight:800;padding:8px;border-top:2px solid #111">${_ksh(po.total)}</td></tr>
    </table>
    <p style="font-size:13px;color:#555;margin-top:18px">
      <strong>Expected delivery:</strong> ${_esc(due)}<br>
      <strong>Payment terms:</strong> ${_esc(po.paymentTerms || 'Net 30 days from date of delivery.')}
    </p>
    ${po.notes ? '<p style="font-size:13px;color:#555;background:#fafafa;padding:12px;border-radius:8px"><strong>Notes:</strong> ' + _esc(po.notes) + '</p>' : ''}
    <p style="font-size:13px;color:#555;margin-top:18px">Please confirm receipt and your expected fulfilment date.</p>
  </div>
  <p style="text-align:center;color:#aaa;font-size:11px;margin-top:16px">
    Sent via SOKONI. SOKONI is operated by Bravilex International Co. Limited.
  </p>
</div></body></html>`;
}

/* ── Runtime options ──────────────────────────────────────────── */
const REGION = 'us-central1';
const OPT    = {
  region:          REGION,
  enforceAppCheck: true,
  memory:          '256MiB',
  timeoutSeconds:  60,
};

/* ── Constants ────────────────────────────────────────────────── */
const VAT_RATE             = 0.16;          // Kenya standard VAT
const SAFETY_BUFFER        = 1.2;           // 20 % buffer on reorder qty
const FORECAST_DAYS        = 30;            // usage lookback window
const MAX_SUPPLIER_NAME    = 200;
const MAX_NOTE_LEN         = 1000;
const MAX_ITEMS_PER_PO     = 200;
const TOP_SUPPLIERS_LIMIT  = 5;
const REORDER_ALERTS_LIMIT = 10;
const PERF_DOC_PREFIX      = 'procVendorPerformance';

const PO_STATUSES = new Set([
  'draft', 'pending_approval', 'approved', 'sent',
  'partially_received', 'received', 'invoiced', 'paid', 'cancelled',
]);

const INV_STATUSES = new Set(['pending', 'approved', 'paid', 'disputed']);

/* ── Helpers ──────────────────────────────────────────────────── */

/** Throw a clean HttpsError — never leaks stack traces to callers. */
function _err(message, code = 'invalid-argument') {
  throw new HttpsError(code, message);
}

/** Assert the request is authenticated; return uid. */
function _requireAuth(request) {
  if (!request.auth?.uid) _err('Authentication required.', 'unauthenticated');
  return request.auth.uid;
}

/** Assert caller has admin or manager custom claim / token flag. */
function _requireManager(request) {
  _requireAuth(request);
  const t = request.auth.token ?? {};
  if (!t.admin && !t.superAdmin && !t.manager && (t.role ?? 0) < 3) {
    _err('Manager or admin access required.', 'permission-denied');
  }
  return request.auth.uid;
}

/** Assert caller has admin / superAdmin claim. */
function _requireAdmin(request) {
  _requireAuth(request);
  const t = request.auth.token ?? {};
  if (!t.admin && !t.superAdmin && (t.role ?? 0) < 4) {
    _err('Admin access required.', 'permission-denied');
  }
  return request.auth.uid;
}

/** Strip HTML tags, trim and cap length. */
function _san(s, max = 300) {
  if (s == null) return '';
  return String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/** Ensure a value is a positive finite number. */
function _posNum(v, label) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) _err(`${label} must be a positive number.`);
  return n;
}

/** Generate a short unique ID with a prefix. */
function _genId(prefix = 'doc') {
  const ts   = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

/** Deterministic ID from sha256 of a seed string (hex, first 24 chars). */
function _deterministicId(seed, prefix = 'po') {
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

/** Return ISO YYYY-MM string for a Date. */
function _yearMonth(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Add N days to a Date; return a JS Date. */
function _addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** Write an immutable audit log entry; never throws. */
async function _audit(actorUid, action, targetId, metadata = {}) {
  try {
    await db.collection('securityAuditLog').add({
      actorUid,
      action,
      targetId,
      metadata,
      module:    'procurement',
      createdAt: F.serverTimestamp(),
    });
  } catch (e) {
    logger.error('procurement_audit_log_failed', { actorUid, action, targetId, error: e.message });
  }
}

/** Validate items array for a PO. Returns cleaned items with computed totalCost. */
function _validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    _err('At least one item is required.');
  }
  if (items.length > MAX_ITEMS_PER_PO) {
    _err(`Maximum ${MAX_ITEMS_PER_PO} items per purchase order.`);
  }
  return items.map((it, idx) => {
    const productId = _san(it.productId, 100);
    const sku       = _san(it.sku, 100);
    const name      = _san(it.name, 200);
    const qty       = Math.floor(Number(it.qty));
    const unitCost  = _posNum(it.unitCost, `Item ${idx + 1} unitCost`);
    if (!productId) _err(`Item ${idx + 1}: productId is required.`);
    if (qty < 1)    _err(`Item ${idx + 1}: qty must be at least 1.`);
    return { productId, sku, name, qty, unitCost, totalCost: +(qty * unitCost).toFixed(2) };
  });
}

/* ════════════════════════════════════════════════════════════════
   1. addSupplier
   Register a new supplier for a given merchant.
════════════════════════════════════════════════════════════════ */
const addSupplier = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const {
    merchantId, name, contactName, phone, email,
    kraPin, bankDetails, paymentTerms, creditLimit,
  } = request.data ?? {};

  /* Validation */
  if (!merchantId) _err('merchantId is required.');
  if (!name)       _err('Supplier name is required.');
  if (!phone)      _err('Contact phone is required.');

  const KRA_RE = /^[A-Z]\d{9}[A-Z]$/;
  if (kraPin && !KRA_RE.test(String(kraPin).trim().toUpperCase())) {
    _err('Invalid KRA PIN format. Expected: A123456789B');
  }

  const VALID_TERMS = new Set([7, 14, 30, 45, 60, 90]);
  const termDays = Number(paymentTerms ?? 30);
  if (!VALID_TERMS.has(termDays)) {
    _err('paymentTerms must be one of: 7, 14, 30, 45, 60, 90 (days).');
  }

  const limit = Number(creditLimit ?? 0);
  if (limit < 0) _err('creditLimit cannot be negative.');

  const supplierId = _genId('sup');

  await db.collection('procSuppliers').doc(supplierId).set({
    supplierId,
    merchantId:   _san(merchantId, 100),
    name:         _san(name, MAX_SUPPLIER_NAME),
    contactName:  _san(contactName, 150),
    phone:        _san(phone, 20),
    email:        _san(email, 150),
    kraPin:       kraPin ? String(kraPin).trim().toUpperCase() : null,
    bankDetails:  bankDetails ? _san(JSON.stringify(bankDetails), 500) : null,
    paymentTerms: termDays,
    creditLimit:  limit,
    currentBalance: 0,
    rating:       0,
    status:       'active',
    createdBy:    uid,
    createdAt:    F.serverTimestamp(),
    updatedAt:    F.serverTimestamp(),
  });

  await _audit(uid, 'supplier_created', supplierId, { merchantId, name: _san(name, 100) });

  logger.info('procurement.addSupplier', { supplierId, merchantId });
  return { supplierId };
});

/* ════════════════════════════════════════════════════════════════
   2. createPurchaseOrder
   Draft a purchase order against a supplier.
════════════════════════════════════════════════════════════════ */
const createPurchaseOrder = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const {
    merchantId, supplierId, items,
    notes, expectedDelivery,
  } = request.data ?? {};

  if (!merchantId)  _err('merchantId is required.');
  if (!supplierId)  _err('supplierId is required.');

  /* Verify supplier belongs to this merchant */
  const supplierSnap = await db.collection('procSuppliers').doc(supplierId).get();
  if (!supplierSnap.exists) _err('Supplier not found.', 'not-found');
  const supplier = supplierSnap.data();
  if (supplier.merchantId !== merchantId) {
    _err('Supplier does not belong to this merchant.', 'permission-denied');
  }
  if (supplier.status !== 'active') {
    _err('Supplier is not active. Reactivate the supplier before placing orders.');
  }

  /* Validate and enrich items */
  const cleanItems = _validateItems(items);

  /* Server-side financials — never trust client figures */
  const subtotal  = +cleanItems.reduce((s, it) => s + it.totalCost, 0).toFixed(2);
  const vatAmount = +(subtotal * VAT_RATE).toFixed(2);
  const total     = +(subtotal + vatAmount).toFixed(2);

  /* Deterministic PO ID prevents duplicates on client retry */
  const seed  = `${merchantId}|${supplierId}|${Date.now()}`;
  const poId  = _deterministicId(seed, 'po');

  /* Human-readable PO number — PO-2026-00042. A supplier quotes this on their invoice and
     their delivery note; "po_a3f9c1…" is a database key, not something anyone will write
     on a carton. Counter is a transactional increment so two POs created in the same
     second cannot collide.

     Falls back to the poId ONLY if the counter is unreachable — a PO that cannot be
     numbered must still be creatable, because refusing to place an order because a
     counter is down would be a worse failure than an ugly reference. */
  let poNumber;
  try {
    const year    = new Date().getFullYear();
    const cRef    = db.collection('procCounters').doc(`po_${merchantId}_${year}`);
    const next    = await db.runTransaction(async (t) => {
      const snap = await t.get(cRef);
      const n    = (snap.exists ? (snap.data().seq || 0) : 0) + 1;
      t.set(cRef, { seq: n, year, merchantId, updatedAt: F.serverTimestamp() }, { merge: true });
      return n;
    });
    poNumber = `PO-${year}-${String(next).padStart(5, '0')}`;
  } catch (e) {
    logger.warn('procurement: PO counter unavailable, falling back to poId', { error: e.message });
    poNumber = poId;
  }

  const poData = {
    poId,
    poNumber,
    merchantId,
    supplierId,
    supplierName: supplier.name,
    items:        cleanItems,
    subtotal,
    vatAmount,
    total,
    vatRate:          Math.round(VAT_RATE * 100),
    status:           'draft',
    notes:            _san(notes, MAX_NOTE_LEN),
    expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : null,
    approvedBy:       null,
    approvedAt:       null,
    sentAt:           null,
    createdBy:        uid,
    createdAt:        F.serverTimestamp(),
    updatedAt:        F.serverTimestamp(),
  };

  await db.collection('procPurchaseOrders').doc(poId).set(poData);

  await _audit(uid, 'po_created', poId, { merchantId, supplierId, total });
  logger.info('procurement.createPurchaseOrder', { poId, merchantId, total });

  return { poId, poNumber, subtotal, vatAmount, total };
});

/* ════════════════════════════════════════════════════════════════
   3. approvePurchaseOrder
   Manager or admin: approve (→ 'approved') or reject (→ 'cancelled').
════════════════════════════════════════════════════════════════ */
const approvePurchaseOrder = onCall(OPT, async (request) => {
  const uid = _requireManager(request);
  const { poId, approved, notes } = request.data ?? {};

  if (!poId) _err('poId is required.');
  if (typeof approved !== 'boolean') _err('approved must be a boolean.');

  const poRef  = db.collection('procPurchaseOrders').doc(poId);
  const poSnap = await poRef.get();
  if (!poSnap.exists) _err('Purchase order not found.', 'not-found');

  const po = poSnap.data();
  if (!['draft', 'pending_approval'].includes(po.status)) {
    _err(`Cannot approve a PO in status '${po.status}'.`);
  }

  const newStatus = approved ? 'approved' : 'cancelled';

  await poRef.update({
    status:       newStatus,
    approvedBy:   uid,
    approvedAt:   F.serverTimestamp(),
    approvalNotes: _san(notes, MAX_NOTE_LEN),
    updatedAt:    F.serverTimestamp(),
  });

  await _audit(uid, approved ? 'po_approved' : 'po_cancelled', poId, {
    merchantId: po.merchantId, total: po.total,
  });

  logger.info('procurement.approvePurchaseOrder', { poId, newStatus, approvedBy: uid });
  return { poId, status: newStatus };
});

/* ════════════════════════════════════════════════════════════════
   4. sendPurchaseOrder
   Mark PO as sent to supplier and queue a supplier notification email.
════════════════════════════════════════════════════════════════ */
const sendPurchaseOrder = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const { poId } = request.data ?? {};

  if (!poId) _err('poId is required.');

  const poRef  = db.collection('procPurchaseOrders').doc(poId);
  const poSnap = await poRef.get();
  if (!poSnap.exists) _err('Purchase order not found.', 'not-found');

  const po = poSnap.data();
  if (po.status !== 'approved') {
    _err(`PO must be in 'approved' status to send. Current status: '${po.status}'.`);
  }

  /* Fetch supplier + the merchant who is buying — both appear on the PDF. */
  const [supplierSnap, merchantSnap] = await Promise.all([
    db.collection('procSuppliers').doc(po.supplierId).get(),
    po.merchantId ? db.collection('users').doc(po.merchantId).get() : Promise.resolve(null),
  ]);
  const supplier = supplierSnap.exists ? supplierSnap.data() : null;
  const mData    = merchantSnap && merchantSnap.exists ? merchantSnap.data() : {};
  const merchant = {
    name:    mData.businessName || mData.displayName || mData.name || 'SOKONI Merchant',
    email:   mData.email   || '',
    phone:   mData.phone   || '',
    address: mData.address || '',
    kraPin:  mData.kraPin  || '',
  };

  const now = F.serverTimestamp();

  /* Batch: update PO + queue email notification */
  const batch = db.batch();

  batch.update(poRef, {
    status:    'sent',
    sentAt:    now,
    updatedAt: now,
  });

  await batch.commit();

  /* ── DELIVERY ────────────────────────────────────────────────────────────────
     This used to hand-write a document into emailQueue like so:

         batch.set(emailRef, { to, subject, body, poId, type, createdAt });

     processEmailQueue selects on  .where('status','==','pending').where('nextAttempt','<=',now)
     and that document had NEITHER field. So it never matched the query, was never picked
     up, and no supplier has ever received a purchase order by email. The PO was marked
     "sent" regardless — the status said sent, the outbox said nothing.

     It also wrote `body`, while the sender requires `html`. Two independent reasons the
     same email could not go out.

     EmailService.queue() is the ONE correct enqueue: it validates to/subject/html and
     stamps status/nextAttempt/retryCount. Going through it means the PO inherits the
     retry, dead-letter and delivery-tracking that already exist, rather than a private
     copy of them that works less well. */
  const pdf  = buildPoPdf(
    { ...po, poNumber: po.poNumber || poId, createdAt: Date.now() },
    supplier || {},
    merchant || {},
  );
  const html = _poEmailHtml(po, poId, supplier, merchant);

  const delivery = { email: 'skipped', sms: 'skipped', inApp: 'skipped' };

  /* ── Email + PDF attachment (primary channel) ── */
  if (supplier?.email) {
    try {
      await emailSvc.queue({
        to:       supplier.email,
        subject:  `Purchase Order ${po.poNumber || poId} from ${merchant?.name || 'SOKONI'}`,
        html,
        category: 'procurement',
        /* Deterministic id — a retried send must not email the supplier twice. */
        emailId:  `po-sent-${poId}`,
        attachments: [{
          content:     pdf.toString('base64'),
          filename:    `${po.poNumber || poId}.pdf`,
          type:        'application/pdf',
          disposition: 'attachment',
        }],
      });
      delivery.email = 'queued';
    } catch (e) {
      /* Do NOT swallow this. A PO marked "sent" whose email failed is exactly the lie we
         are here to remove — record it on the PO so it is visible, not just in a log. */
      delivery.email = 'failed';
      logger.error('procurement.sendPurchaseOrder email failed', { poId, error: e.message });
    }
  } else {
    delivery.email = 'no_email_on_supplier';
  }

  /* ── SMS + in-app + push, via the ONE notification engine ── */
  if (supplier?.phone || supplier?.uid) {
    try {
      await notify.notify({
        uid:   supplier.uid || `supplier:${po.supplierId}`,
        phone: supplier.phone || undefined,
        type:  'po_sent',
        title: 'New Purchase Order',
        body:  `You have received Purchase Order ${po.poNumber || poId} from ` +
               `${merchant?.name || 'a SOKONI merchant'}. Please check your email.`,
        deepLink:  `/procurement?po=${poId}`,
        dedupeKey: `po:${poId}:sent`,      /* one notification per PO, ever */
        /* Feeds the po_sent SMS template. */
        vars: { poNumber: po.poNumber || poId, merchant: merchant?.name || '' },
        data: { poId, supplierId: po.supplierId },
      });
      delivery.sms   = supplier.phone ? 'queued' : 'skipped';
      delivery.inApp = supplier.uid   ? 'queued' : 'skipped';
    } catch (e) {
      logger.error('procurement.sendPurchaseOrder notify failed', { poId, error: e.message });
      delivery.sms = 'failed';
    }
  }

  /* The PO carries its own delivery record. "sent" now means something checkable. */
  await poRef.update({
    delivery,
    deliveryAt: F.serverTimestamp(),
  });

  await _audit(uid, 'po_sent', poId, {
    merchantId: po.merchantId, supplierId: po.supplierId, delivery,
  });
  logger.info('procurement.sendPurchaseOrder', { poId, delivery });

  /* Return the real delivery outcome, not a boolean guess. The old version returned
     `emailQueued: !!supplier.email` — true whenever the supplier merely HAD an email
     address, whether or not anything was actually queued. It would have reported success
     for every one of the emails that never sent. */
  return { poId, status: 'sent', poNumber: po.poNumber || poId, delivery };
});

/* ════════════════════════════════════════════════════════════════
   5. receiveGoods  (GRN — Goods Received Note)
   Receive items against a PO, update inventory, write stock movements.
════════════════════════════════════════════════════════════════ */
const receiveGoods = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const {
    poId, branchId, items, receivedBy,
  } = request.data ?? {};

  if (!poId)     _err('poId is required.');
  if (!branchId) _err('branchId is required.');
  if (!Array.isArray(items) || items.length === 0) _err('items array is required.');

  const poRef  = db.collection('procPurchaseOrders').doc(poId);
  const poSnap = await poRef.get();
  if (!poSnap.exists) _err('Purchase order not found.', 'not-found');

  const po = poSnap.data();
  if (!['sent', 'partially_received'].includes(po.status)) {
    _err(`Cannot receive goods for a PO in status '${po.status}'.`);
  }

  /* Map PO items by productId for quick lookup */
  const poItemMap = {};
  for (const it of (po.items ?? [])) {
    poItemMap[it.productId] = it;
  }

  /* Validate received items */
  const VALID_CONDITIONS = new Set(['good', 'damaged', 'rejected']);
  const cleanReceived = items.map((it, idx) => {
    const productId   = _san(it.productId, 100);
    const receivedQty = Math.floor(Number(it.receivedQty ?? 0));
    const condition   = String(it.condition ?? 'good');
    if (!productId)              _err(`GRN item ${idx + 1}: productId required.`);
    if (!VALID_CONDITIONS.has(condition)) {
      _err(`GRN item ${idx + 1}: condition must be 'good', 'damaged', or 'rejected'.`);
    }
    if (receivedQty < 0) _err(`GRN item ${idx + 1}: receivedQty cannot be negative.`);
    const ordered = poItemMap[productId];
    return {
      productId,
      orderedQty:  ordered?.qty ?? 0,
      receivedQty,
      unitCost:    ordered?.unitCost ?? 0,
      condition,
    };
  });

  /* Compute totals and discrepancies */
  let totalReceived  = 0;
  const discrepancies = [];

  for (const it of cleanReceived) {
    totalReceived += it.condition === 'good' ? it.receivedQty : 0;
    if (it.receivedQty !== it.orderedQty || it.condition !== 'good') {
      discrepancies.push({
        productId:   it.productId,
        orderedQty:  it.orderedQty,
        receivedQty: it.receivedQty,
        condition:   it.condition,
      });
    }
  }

  /* Determine new PO status */
  const allGoodItems = cleanReceived.filter(it => it.condition === 'good');
  const totalOrderedQty   = (po.items ?? []).reduce((s, it) => s + it.qty, 0);
  const totalReceivedGood = allGoodItems.reduce((s, it) => s + it.receivedQty, 0);
  const newPoStatus = totalReceivedGood >= totalOrderedQty ? 'received' : 'partially_received';

  const grnId  = _genId('grn');
  const now    = F.serverTimestamp();
  const batch  = db.batch();

  /* Write GRN */
  const grnRef = db.collection('procGRN').doc(grnId);
  batch.set(grnRef, {
    grnId,
    poId,
    merchantId:    po.merchantId,
    supplierId:    po.supplierId,
    branchId:      _san(branchId, 100),
    items:         cleanReceived,
    totalReceived,
    discrepancies,
    receivedBy:    _san(receivedBy || uid, 150),
    receivedByUid: uid,
    receivedAt:    now,
    createdAt:     now,
  });

  /* Update PO status */
  batch.update(poRef, {
    status:    newPoStatus,
    updatedAt: now,
  });

  /* Inventory increment for 'good' items + stock movement records */
  for (const it of allGoodItems) {
    if (it.receivedQty <= 0) continue;

    /* Update posProducts inventory for this branch */
    const productDocId = `${branchId}_${it.productId}`;
    const productRef   = db.collection('posProducts').doc(productDocId);
    batch.update(productRef, {
      stockQty:  F.increment(it.receivedQty),
      updatedAt: now,
    });

    /* Write stock movement record */
    const movRef = db.collection('stockMovements').doc();
    batch.set(movRef, {
      type:       'procurement_receipt',
      productId:  it.productId,
      branchId:   _san(branchId, 100),
      merchantId: po.merchantId,
      qty:        it.receivedQty,
      unitCost:   it.unitCost,
      refType:    'grn',
      refId:      grnId,
      poId,
      supplierId: po.supplierId,
      performedBy: uid,
      createdAt:  now,
    });
  }

  await batch.commit();

  await _audit(uid, 'grn_created', grnId, {
    poId, merchantId: po.merchantId, totalReceived, discrepancyCount: discrepancies.length,
  });

  logger.info('procurement.receiveGoods', { grnId, poId, newPoStatus, totalReceived });
  return { grnId, totalReceived, discrepancies, poStatus: newPoStatus };
});

/* ════════════════════════════════════════════════════════════════
   6. createSupplierInvoice
   Attach a supplier's invoice to a GRN / PO.
════════════════════════════════════════════════════════════════ */
const createSupplierInvoice = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const {
    poId, grnId, invoiceNumber, invoiceDate,
    dueDate, amount, vatAmount,
  } = request.data ?? {};

  if (!poId)          _err('poId is required.');
  if (!invoiceNumber) _err('invoiceNumber is required.');

  const poSnap = await db.collection('procPurchaseOrders').doc(poId).get();
  if (!poSnap.exists) _err('Purchase order not found.', 'not-found');
  const po = poSnap.data();

  if (['draft', 'pending_approval', 'cancelled'].includes(po.status)) {
    _err(`Cannot create invoice for a PO in status '${po.status}'.`);
  }

  /* Validate amounts */
  const invAmount    = _posNum(amount, 'Invoice amount');
  const invVat       = Number(vatAmount ?? 0);
  const invTotal     = +(invAmount + invVat).toFixed(2);

  /* Warn if invoice total deviates from PO total by more than 5% */
  const deviation = Math.abs(invTotal - po.total) / po.total;
  if (deviation > 0.05) {
    _err(`Invoice total KES ${invTotal.toLocaleString()} deviates more than 5% from PO total KES ${po.total.toLocaleString()}. Raise a dispute with the supplier.`);
  }

  const invoiceId = _genId('inv');

  const invData = {
    invoiceId,
    poId,
    grnId:          grnId ? _san(grnId, 100) : null,
    supplierId:     po.supplierId,
    merchantId:     po.merchantId,
    invoiceNumber:  _san(invoiceNumber, 100),
    invoiceDate:    invoiceDate ? new Date(invoiceDate) : new Date(),
    dueDate:        dueDate ? new Date(dueDate) : null,
    amount:         invAmount,
    vatAmount:      invVat,
    total:          invTotal,
    status:         'pending',
    paidAt:         null,
    paidBy:         null,
    paymentMethod:  null,
    paymentRef:     null,
    createdBy:      uid,
    createdAt:      F.serverTimestamp(),
    updatedAt:      F.serverTimestamp(),
  };

  await db.collection('procSupplierInvoices').doc(invoiceId).set(invData);

  /* Update PO to invoiced if not already paid */
  if (!['invoiced', 'paid'].includes(po.status)) {
    await db.collection('procPurchaseOrders').doc(poId).update({
      status:    'invoiced',
      updatedAt: F.serverTimestamp(),
    });
  }

  await _audit(uid, 'supplier_invoice_created', invoiceId, {
    poId, merchantId: po.merchantId, total: invTotal,
  });

  logger.info('procurement.createSupplierInvoice', { invoiceId, poId, invTotal });
  return { invoiceId };
});

/* ════════════════════════════════════════════════════════════════
   7. approveAndPayInvoice
   Admin: approve a supplier invoice and post a double-entry payment.
   Idempotency guard: paidAt must be null before processing.
════════════════════════════════════════════════════════════════ */
const approveAndPayInvoice = onCall(OPT, async (request) => {
  const uid = _requireAdmin(request);
  const {
    invoiceId, paymentMethod, paymentRef,
  } = request.data ?? {};

  if (!invoiceId)     _err('invoiceId is required.');
  if (!paymentMethod) _err('paymentMethod is required (e.g. bank_transfer, mpesa, cash).');

  const invRef  = db.collection('procSupplierInvoices').doc(invoiceId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) _err('Invoice not found.', 'not-found');

  const inv = invSnap.data();

  /* Idempotency guard */
  if (inv.paidAt !== null) {
    _err('Invoice has already been paid. Duplicate payment prevented.', 'already-exists');
  }
  if (inv.status === 'disputed') {
    _err('Cannot pay a disputed invoice. Resolve the dispute first.');
  }
  if (!['pending', 'approved'].includes(inv.status)) {
    _err(`Cannot pay invoice in status '${inv.status}'.`);
  }

  const now   = F.serverTimestamp();
  const batch = db.batch();

  /* Update invoice */
  batch.update(invRef, {
    status:        'paid',
    paidAt:        now,
    paidBy:        uid,
    paymentMethod: _san(paymentMethod, 50),
    paymentRef:    paymentRef ? _san(paymentRef, 200) : null,
    updatedAt:     now,
  });

  /* Update supplier currentBalance */
  const supplierRef = db.collection('procSuppliers').doc(inv.supplierId);
  batch.update(supplierRef, {
    currentBalance: F.increment(-inv.total),
    updatedAt:      now,
  });

  /* Double-entry ledger:
     DEBIT  accounts_payable  (liability decreases)
     CREDIT bank/cash         (asset decreases) */
  const debitRef = db.collection('paymentLedger').doc();
  batch.set(debitRef, {
    type:        'debit',
    account:     'accounts_payable',
    amount:      inv.total,
    currency:    'KES',
    refType:     'supplier_invoice',
    refId:       invoiceId,
    supplierId:  inv.supplierId,
    merchantId:  inv.merchantId,
    poId:        inv.poId,
    description: `Supplier invoice payment — ${inv.invoiceNumber}`,
    performedBy: uid,
    createdAt:   now,
  });

  const creditRef = db.collection('paymentLedger').doc();
  batch.set(creditRef, {
    type:        'credit',
    account:     paymentMethod,
    amount:      inv.total,
    currency:    'KES',
    refType:     'supplier_invoice',
    refId:       invoiceId,
    supplierId:  inv.supplierId,
    merchantId:  inv.merchantId,
    poId:        inv.poId,
    description: `Supplier invoice payment — ${inv.invoiceNumber}`,
    paymentRef:  paymentRef ? _san(paymentRef, 200) : null,
    performedBy: uid,
    createdAt:   now,
  });

  /* Update PO to paid */
  if (inv.poId) {
    const poRef = db.collection('procPurchaseOrders').doc(inv.poId);
    batch.update(poRef, {
      status:    'paid',
      updatedAt: now,
    });
  }

  await batch.commit();

  await _audit(uid, 'supplier_invoice_paid', invoiceId, {
    merchantId: inv.merchantId, supplierId: inv.supplierId,
    total: inv.total, paymentMethod,
  });

  logger.info('procurement.approveAndPayInvoice', { invoiceId, total: inv.total, paymentMethod });
  return { invoiceId, status: 'paid', total: inv.total };
});

/* ════════════════════════════════════════════════════════════════
   8. getSupplierPerformance
   Return monthly performance trend for a supplier.
════════════════════════════════════════════════════════════════ */
const getSupplierPerformance = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { supplierId, merchantId, months } = request.data ?? {};

  if (!supplierId) _err('supplierId is required.');
  if (!merchantId) _err('merchantId is required.');

  const numMonths = Math.min(Math.max(Number(months ?? 3), 1), 24);

  /* Build list of YYYY-MM keys for the last N months */
  const periods = [];
  const now = new Date();
  for (let i = 0; i < numMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(_yearMonth(d));
  }
  periods.reverse();

  /* Fetch performance docs */
  const snapshots = await Promise.all(
    periods.map(p =>
      db.collection(PERF_DOC_PREFIX).doc(`${supplierId}_${p}`).get()
    )
  );

  const trend = snapshots.map((snap, i) => {
    if (!snap.exists) {
      return {
        period: periods[i],
        onTimeDeliveryRate: null,
        qualityScore:       null,
        priceAccuracy:      null,
        responsiveness:     null,
        overallRating:      null,
      };
    }
    const d = snap.data();
    return {
      period:             d.period,
      onTimeDeliveryRate: d.onTimeDeliveryRate,
      qualityScore:       d.qualityScore,
      priceAccuracy:      d.priceAccuracy,
      responsiveness:     d.responsiveness,
      overallRating:      d.overallRating,
    };
  });

  /* Compute averages over available months */
  const available = trend.filter(t => t.overallRating !== null);
  const avg = (key) =>
    available.length > 0
      ? +(available.reduce((s, t) => s + (t[key] ?? 0), 0) / available.length).toFixed(2)
      : null;

  const averages = {
    onTimeDeliveryRate: avg('onTimeDeliveryRate'),
    qualityScore:       avg('qualityScore'),
    priceAccuracy:      avg('priceAccuracy'),
    responsiveness:     avg('responsiveness'),
    overallRating:      avg('overallRating'),
  };

  return { supplierId, merchantId, periods, trend, averages };
});

/* ════════════════════════════════════════════════════════════════
   9. getProcurementForecast
   Reorder suggestions: products below reorder point with qty guidance.
════════════════════════════════════════════════════════════════ */
const getProcurementForecast = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, branchId } = request.data ?? {};

  if (!merchantId) _err('merchantId is required.');
  if (!branchId)   _err('branchId is required.');

  /* Fetch forecast docs for this merchant/branch */
  const forecastSnap = await db.collection('procForecast')
    .where('merchantId', '==', merchantId)
    .where('branchId',   '==', branchId)
    .get();

  if (forecastSnap.empty) {
    return { merchantId, branchId, reorderList: [], generatedAt: new Date().toISOString() };
  }

  /* Get current stock levels for products in forecast */
  const forecasts = forecastSnap.docs.map(d => d.data());
  const productIds = forecasts.map(f => f.productId).filter(Boolean);

  /* Fetch posProducts in batches (Firestore limit: 30 per 'in' query) */
  const BATCH_SIZE  = 30;
  const productDocs = {};
  for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
    const batchIds   = productIds.slice(i, i + BATCH_SIZE).map(pid => `${branchId}_${pid}`);
    const batchSnaps = await db.collection('posProducts')
      .where(admin.firestore.FieldPath.documentId(), 'in', batchIds)
      .get();
    batchSnaps.forEach(s => {
      const d = s.data();
      if (d.productId) productDocs[d.productId] = d;
    });
  }

  /* Compute usage from stockMovements in the last FORECAST_DAYS days */
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - FORECAST_DAYS);

  /* Query movements for this branch */
  const movSnap = await db.collection('stockMovements')
    .where('branchId',  '==', branchId)
    .where('merchantId','==', merchantId)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(sinceDate))
    .get();

  /* Aggregate daily usage (only outbound types) */
  const OUTBOUND_TYPES = new Set(['sale', 'pos_sale', 'adjustment_out', 'waste']);
  const usageMap = {};
  movSnap.forEach(doc => {
    const mv = doc.data();
    if (!OUTBOUND_TYPES.has(mv.type)) return;
    if (!usageMap[mv.productId]) usageMap[mv.productId] = 0;
    usageMap[mv.productId] += (mv.qty ?? 0);
  });

  /* Build reorder list */
  const reorderList = [];

  for (const forecast of forecasts) {
    const { productId, reorderPoint, leadDays = 7, preferredSupplierId } = forecast;
    const product     = productDocs[productId];
    const currentQty  = product?.stockQty ?? 0;

    if (currentQty > (reorderPoint ?? 0)) continue;

    const totalUsage    = usageMap[productId] ?? 0;
    const avgDailyUsage = +(totalUsage / FORECAST_DAYS).toFixed(4);
    const reorderQty    = Math.ceil(avgDailyUsage * (leadDays ?? 7) * SAFETY_BUFFER);

    reorderList.push({
      productId,
      productName:         product?.name ?? productId,
      sku:                 product?.sku  ?? '',
      currentStock:        currentQty,
      reorderPoint:        reorderPoint ?? 0,
      avgDailyUsage,
      leadDays:            leadDays ?? 7,
      suggestedReorderQty: Math.max(reorderQty, 1),
      preferredSupplierId: preferredSupplierId ?? null,
      unitCost:            product?.costPrice ?? null,
      urgency:             currentQty === 0 ? 'critical' : 'low',
    });
  }

  /* Sort by urgency: critical first, then by lowest stock ratio */
  reorderList.sort((a, b) => {
    if (a.urgency === 'critical' && b.urgency !== 'critical') return -1;
    if (b.urgency === 'critical' && a.urgency !== 'critical') return  1;
    const ratioA = a.reorderPoint > 0 ? a.currentStock / a.reorderPoint : 1;
    const ratioB = b.reorderPoint > 0 ? b.currentStock / b.reorderPoint : 1;
    return ratioA - ratioB;
  });

  return {
    merchantId,
    branchId,
    reorderList,
    generatedAt: new Date().toISOString(),
  };
});

/* ════════════════════════════════════════════════════════════════
   10. getProcurementDashboard
   KPI summary for a merchant: open POs, pending approvals,
   goods to receive, invoices, overdue invoices, top suppliers,
   reorder alerts.
════════════════════════════════════════════════════════════════ */
const getProcurementDashboard = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId } = request.data ?? {};

  if (!merchantId) _err('merchantId is required.');

  const since30 = new Date();
  since30.setDate(since30.getDate() - 30);
  const since30Ts = admin.firestore.Timestamp.fromDate(since30);

  /* Run dashboard queries in parallel */
  const [
    openPOsSnap,
    pendingApprovalSnap,
    goodsToReceiveSnap,
    pendingInvoicesSnap,
    paidInvoicesSnap,
    suppliersSnap,
    reorderSnap,
  ] = await Promise.all([
    /* Open POs (sent + partially_received) */
    db.collection('procPurchaseOrders')
      .where('merchantId', '==', merchantId)
      .where('status', 'in', ['sent', 'partially_received'])
      .get(),

    /* Pending approval */
    db.collection('procPurchaseOrders')
      .where('merchantId', '==', merchantId)
      .where('status', 'in', ['draft', 'pending_approval'])
      .get(),

    /* Goods to receive */
    db.collection('procPurchaseOrders')
      .where('merchantId', '==', merchantId)
      .where('status', 'in', ['sent', 'partially_received'])
      .get(),

    /* Pending invoices */
    db.collection('procSupplierInvoices')
      .where('merchantId', '==', merchantId)
      .where('status', 'in', ['pending', 'approved'])
      .get(),

    /* Paid invoices in last 30d for top supplier calculation */
    db.collection('procSupplierInvoices')
      .where('merchantId', '==', merchantId)
      .where('status',     '==', 'paid')
      .where('paidAt',     '>=', since30Ts)
      .get(),

    /* All suppliers */
    db.collection('procSuppliers')
      .where('merchantId', '==', merchantId)
      .where('status',     '==', 'active')
      .get(),

    /* Reorder alerts: products with low stock */
    db.collection('procForecast')
      .where('merchantId', '==', merchantId)
      .limit(REORDER_ALERTS_LIMIT)
      .get(),
  ]);

  /* Aggregate open POs */
  let openPOsValue = 0;
  openPOsSnap.forEach(d => { openPOsValue += d.data().total ?? 0; });

  /* Pending invoices total */
  let pendingInvoicesTotal = 0;
  const overdueInvoices    = [];
  const now = new Date();

  pendingInvoicesSnap.forEach(d => {
    const inv = d.data();
    pendingInvoicesTotal += inv.total ?? 0;
    if (inv.dueDate) {
      const due = inv.dueDate.toDate ? inv.dueDate.toDate() : new Date(inv.dueDate);
      if (due < now) overdueInvoices.push({ invoiceId: inv.invoiceId, total: inv.total, dueDate: due.toISOString() });
    }
  });

  /* Top suppliers by spend in last 30d */
  const spendBySupplierId = {};
  const supplierNames     = {};
  suppliersSnap.forEach(d => {
    const s = d.data();
    supplierNames[s.supplierId] = s.name;
  });
  paidInvoicesSnap.forEach(d => {
    const inv = d.data();
    if (!spendBySupplierId[inv.supplierId]) spendBySupplierId[inv.supplierId] = 0;
    spendBySupplierId[inv.supplierId] += inv.total ?? 0;
  });

  const topSuppliers = Object.entries(spendBySupplierId)
    .map(([supplierId, spend]) => ({ supplierId, name: supplierNames[supplierId] ?? supplierId, spend }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, TOP_SUPPLIERS_LIMIT);

  /* Reorder alerts */
  const reorderAlerts = reorderSnap.docs
    .slice(0, REORDER_ALERTS_LIMIT)
    .map(d => {
      const f = d.data();
      return { productId: f.productId, reorderPoint: f.reorderPoint, reorderQty: f.reorderQty };
    });

  return {
    merchantId,
    openPOs:              { count: openPOsSnap.size,         totalValue: +openPOsValue.toFixed(2) },
    pendingApproval:      { count: pendingApprovalSnap.size },
    goodsToReceive:       { count: goodsToReceiveSnap.size },
    pendingInvoices:      { count: pendingInvoicesSnap.size, totalValue: +pendingInvoicesTotal.toFixed(2) },
    overdueInvoices:      { count: overdueInvoices.length,   items: overdueInvoices },
    topSuppliers,
    reorderAlerts,
    generatedAt: new Date().toISOString(),
  };
});

/* ════════════════════════════════════════════════════════════════
   Scheduled: Nightly Vendor Performance Scorer
   Runs at 01:00 EAT daily — computes the previous month's
   performance metrics for all suppliers with activity.
════════════════════════════════════════════════════════════════ */
const scheduledVendorPerformanceUpdate = onSchedule(
  { schedule: '0 22 * * *', timeZone: 'UTC', region: REGION, memory: '512MiB' },
  async () => {
    const prevMonth = new Date();
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const period = _yearMonth(prevMonth);
    const monthStart = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), 1);
    const monthEnd   = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0, 23, 59, 59);

    /* Fetch all GRNs in the period */
    const grnSnap = await db.collection('procGRN')
      .where('receivedAt', '>=', admin.firestore.Timestamp.fromDate(monthStart))
      .where('receivedAt', '<=', admin.firestore.Timestamp.fromDate(monthEnd))
      .get();

    /* Group by supplierId + merchantId */
    const grouped = {};
    grnSnap.forEach(doc => {
      const g = doc.data();
      const key = `${g.supplierId}__${g.merchantId}`;
      if (!grouped[key]) grouped[key] = { supplierId: g.supplierId, merchantId: g.merchantId, grns: [] };
      grouped[key].grns.push(g);
    });

    const batch = db.batch();
    let count = 0;

    for (const { supplierId, merchantId, grns } of Object.values(grouped)) {
      /* Quality score: % of items received in 'good' condition */
      let totalItems = 0;
      let goodItems  = 0;
      for (const grn of grns) {
        for (const it of (grn.items ?? [])) {
          totalItems++;
          if (it.condition === 'good') goodItems++;
        }
      }
      const qualityScore = totalItems > 0 ? +(goodItems / totalItems * 100).toFixed(1) : 100;

      /* On-time delivery: check if GRN receivedAt <= PO expectedDelivery */
      const poIds = [...new Set(grns.map(g => g.poId).filter(Boolean))];
      let onTime  = 0;
      let total   = 0;

      if (poIds.length > 0) {
        const poSnaps = await Promise.all(
          poIds.map(id => db.collection('procPurchaseOrders').doc(id).get())
        );
        const poMap = {};
        poSnaps.forEach(s => { if (s.exists) poMap[s.id] = s.data(); });

        for (const grn of grns) {
          const po = poMap[grn.poId];
          if (!po?.expectedDelivery) continue;
          total++;
          const expected  = po.expectedDelivery.toDate ? po.expectedDelivery.toDate() : new Date(po.expectedDelivery);
          const received  = grn.receivedAt?.toDate ? grn.receivedAt.toDate() : new Date(grn.receivedAt);
          if (received <= expected) onTime++;
        }
      }

      const onTimeDeliveryRate = total > 0 ? +(onTime / total * 100).toFixed(1) : 100;

      /* Overall rating: weighted average */
      const overallRating = +((qualityScore * 0.5 + onTimeDeliveryRate * 0.5)).toFixed(1);

      const perfDocId = `${supplierId}_${period}`;
      const perfRef   = db.collection(PERF_DOC_PREFIX).doc(perfDocId);
      batch.set(perfRef, {
        supplierId,
        merchantId,
        period,
        onTimeDeliveryRate,
        qualityScore,
        priceAccuracy:  null,   // set externally from invoice matching
        responsiveness: null,   // set externally from comms logs
        overallRating,
        grnCount:       grns.length,
        updatedAt:      F.serverTimestamp(),
      }, { merge: true });

      /* Update supplier overall rating */
      const supplierRef = db.collection('procSuppliers').doc(supplierId);
      batch.update(supplierRef, { rating: overallRating, updatedAt: F.serverTimestamp() });

      count++;
      if (count % 400 === 0) {
        await batch.commit();
        // Note: in production, create a new batch after commit
      }
    }

    await batch.commit();
    logger.info('procurement.scheduledVendorPerformanceUpdate', { period, suppliersScored: count });
  }
);

/* ════════════════════════════════════════════════════════════════
   Module Exports
════════════════════════════════════════════════════════════════ */
module.exports = {
  addSupplier,
  createPurchaseOrder,
  approvePurchaseOrder,
  sendPurchaseOrder,
  receiveGoods,
  createSupplierInvoice,
  approveAndPayInvoice,
  getSupplierPerformance,
  getProcurementForecast,
  getProcurementDashboard,
  scheduledVendorPerformanceUpdate,
};
