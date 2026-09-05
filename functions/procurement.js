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
const { assertMerchantAccess } = require('./merchant-authority');
const { _assertBusinessPermission } = require('./workforce-identity');
const { resolveMerchantIdForOwner, REASON: TENANT_REASON } = require('./tenant-identity');
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

/**
 * MERCHANT-SCOPED AUTHORITY — the gate every merchant-owned operation in this module
 * must pass. Role is not tenancy: `_requireManager` proves a caller holds a manager
 * claim, never that they hold it FOR THIS MERCHANT, so a manager at merchant A could
 * act on merchant B. Six of this module's operations previously required only
 * `_requireAuth` — signed-in-ness — while accepting `merchantId` from the payload.
 *
 * Composition, deliberately, rather than a second primitive:
 *   1. `assertMerchantAccess` (functions/merchant-authority.js) — the canonical, shared
 *      check against `businesses/{merchantId}.ownerId` (+ adminUids, + unforgeable
 *      platform claims). Fails CLOSED on a missing authority document.
 *   2. the employee path — an active `workspaceMemberships` record carrying the
 *      EXISTING `pos` capability. Membership alone is not authority.
 *
 * No `users/{uid}` identity field is consulted: merchantId, sellerId, businessId and
 * shopId there are all self-writable, so a check against one is theatre.
 *
 * @returns {Promise<string>} the AUTHORIZED merchantId — use this, never the payload's.
 */
async function _assertMerchantAuthority(request, requested) {
  const auth = request && request.auth;
  if (!auth || !auth.uid) _err('Authentication required.', 'unauthenticated');
  try {
    return await assertMerchantAccess(auth, requested);
  } catch (e) {
    /* Only a tenancy denial may fall through to the capability path. An
       invalid-argument or unauthenticated error is final. */
    if (!e || e.code !== 'permission-denied') throw e;
    const merchantId = (requested === undefined || requested === null || requested === '')
      ? String(auth.uid) : String(requested);
    /* Throws unless the membership is active AND carries the capability. */
    await _assertBusinessPermission(String(auth.uid), merchantId, 'pos');
    return merchantId;
  }
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
    merchantId: _requestedMerchantId, supplierBusinessId, name, contactName, phone, email,
    kraPin, bankDetails, paymentTerms, creditLimit,
  } = request.data ?? {};

  /* Validation */
  /* AUTHORITY, not an argument. The payload's merchantId is a REQUEST; the authorized
     value comes back from the shared primitive and is the only one written below. Before
     this, any authenticated user could create a supplier under any merchant. */
  const merchantId = await _assertMerchantAuthority(request, _requestedMerchantId);
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

  /* Verify the SOKONI counterparty BEFORE minting an id, so a rejected relationship
     leaves nothing behind. */
  const _verifiedSupplierBusinessId = supplierBusinessId
    ? await _assertSuppliesEnabled(supplierBusinessId)
    : null;

  const supplierId = _genId('sup');

  await db.collection('procSuppliers').doc(supplierId).set({
    supplierId,
    merchantId:   _san(merchantId, 100),
    /* The SOKONI counterparty, when there is one. procSuppliers is a RELATIONSHIP row:
       it links this buyer to a supplier. For a business already on SOKONI that supplier is
       businesses/{id} — the same canonical identity it trades under, never a duplicate
       account. Null for genuinely external suppliers, whose contact fields below carry
       everything instead. Verified, not trusted: the business must exist AND have opted
       into supply. A client naming any business id would otherwise enrol it as a supplier
       without its consent. */
    supplierBusinessId: _verifiedSupplierBusinessId,
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
   0. resolveMerchantContext — WHICH BUSINESS AM I ACTING FOR?

   The Merchant V2 shell resolves a `shopId` (merchantIdentity / resolveActor, ownership
   derived from `uid === shopId`). Every procurement operation is keyed on a `merchantId`,
   which is a `businesses/{id}` document id. THESE ARE NOT THE SAME IDENTIFIER, and they
   coincide only in the owner-uid form. Passing an activeShopId as a merchantId would
   silently address whichever business happened to share that key.

   That is not hypothetical. Production holds an owner with THREE `businesses` documents,
   TWO of them simultaneously active (identifier census, 2026-09-04). For that account there
   is no single correct answer to "my business", so this refuses and returns the choices
   rather than picking one. A Supply surface showing the wrong business's spend, stock and
   payables is worse than one that asks.

   No second resolver is introduced. Ownership resolution is `tenant-identity`'s
   `resolveMerchantIdForOwner` (the canonical one, which already refuses on AMBIGUOUS), and
   authorization of an explicit choice is `_assertMerchantAuthority` — the same primitive
   every other operation in this module uses.

   Never reads localStorage, a URL, or any `users/{uid}` identity field: all four of those
   fields are self-writable, and the shell's own localStorage fallback can hand back a uid
   from a previous session.
════════════════════════════════════════════════════════════════ */

/** The shape of the id, for callers that need to know which space they are in. */
function _merchantIdForm(merchantId, uid) {
  return String(merchantId) === String(uid) ? 'owner-uid' : 'generated';
}

const resolveMerchantContext = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const { businessId } = request.data ?? {};

  /* ── An explicit choice: authorize it, never merely accept it. ───────────────────
     This is how a multi-business owner proceeds after the selection state below. The
     caller names a business; the server decides whether they may act for it. */
  if (businessId) {
    const merchantId = await _assertMerchantAuthority(request, String(businessId));
    const snap = await db.collection('businesses').doc(merchantId).get();
    if (!snap.exists) _err('Business not found.', 'not-found');
    const b = snap.data() || {};
    return {
      resolved:   true,
      merchantId,
      form:       _merchantIdForm(merchantId, uid),
      selected:   true,
      name:       b.name || b.businessName || null,
      supplyEnabled: !!(b.supply && b.supply.enabled === true),
      choices:    [],
      reason:     null,
    };
  }

  /* ── No choice supplied: resolve, or refuse. ────────────────────────────────────── */
  const owned = await resolveMerchantIdForOwner(String(uid));

  if (owned && owned.ok) {
    const snap = await db.collection('businesses').doc(owned.merchantId).get();
    const b = snap.exists ? (snap.data() || {}) : {};
    return {
      resolved:   true,
      merchantId: owned.merchantId,
      form:       _merchantIdForm(owned.merchantId, uid),
      selected:   false,
      name:       b.name || b.businessName || null,
      supplyEnabled: !!(b.supply && b.supply.enabled === true),
      choices:    [],
      reason:     null,
    };
  }

  const reason = (owned && owned.reason) || TENANT_REASON.UNLINKED;

  /* AMBIGUOUS is the case this operation exists for. Return the candidates so the shell
     can present a selection state — an unresolved context with the information needed to
     resolve it is useful; an arbitrarily chosen one is a defect. */
  let choices = [];
  if (reason === TENANT_REASON.AMBIGUOUS) {
    const snap = await db.collection('businesses')
      .where('ownerId', '==', String(uid))
      .limit(20)
      .get();
    choices = snap.docs.map((d) => {
      const b = d.data() || {};
      return {
        businessId: d.id,
        name:       b.name || b.businessName || null,
        status:     b.status || null,
        form:       _merchantIdForm(d.id, uid),
        supplyEnabled: !!(b.supply && b.supply.enabled === true),
      };
    });
  }

  logger.info('procurement.resolveMerchantContext', { resolved: false, reason, choiceCount: choices.length });
  return { resolved: false, merchantId: null, form: null, selected: false, name: null,
           supplyEnabled: false, choices, reason };
});
/* ════════════════════════════════════════════════════════════════
   1a. SUPPLY PARTICIPATION — a business opts in to supplying other businesses.

   SOKONI has ONE canonical identity: businesses/{businessId}. A merchant that also
   supplies other businesses is the SAME business, not a second account. Supply is a
   CAPABILITY on that identity, never a separate supplier record.

   Participation is explicit and server-authoritative. It is deliberately NOT inferred
   from owning products, nor from wholesaleEnabled on individual products: a merchant
   listing goods for consumers has not thereby agreed to receive purchase orders from
   other businesses, and inferring that would enrol them without consent.
════════════════════════════════════════════════════════════════ */

/** The only supply fields a client may set. Ownership and derived state are excluded. */
const SUPPLY_MUTABLE = ['enabled', 'displayName', 'categories', 'minOrderValue',
                        'leadDays', 'deliveryAreas', 'notes',
                        /* Discovery consent — SEPARATE from participation. See below. */
                        'discoverable'];

/**
 * Resolve the business a caller may declare supply participation FOR.
 *
 * Stricter than _assertMerchantAuthority on purpose. That helper honours the owner-uid
 * form (merchantId === auth.uid) without a lookup, which is correct for everyday
 * operations — but production contains an owner with THREE businesses documents, two
 * simultaneously ACTIVE (census 2026-09-04). Letting a uid stand in for "my business"
 * during an opt-in would enrol whichever record the short-circuit happened to name, and
 * a supplier discoverable under the wrong one of its owner's two businesses is a
 * data-integrity problem, not a cosmetic one.
 *
 * So: an explicitly-named businessId is authorized normally. A bare uid is resolved
 * through the canonical resolver, which REFUSES when the owner has more than one.
 */
async function _assertSupplyDeclarationTarget(request, requestedBusinessId) {
  const auth = request && request.auth;
  if (!auth || !auth.uid) _err('Authentication required.', 'unauthenticated');

  if (requestedBusinessId && requestedBusinessId !== auth.uid) {
    /* Explicit target — ordinary merchant authority applies. */
    return await _assertMerchantAuthority(request, requestedBusinessId);
  }

  /* Bare uid (or omitted): resolve, and refuse rather than guess. */
  const owned = await resolveMerchantIdForOwner(String(auth.uid));
  if (!owned || !owned.ok) {
    if (owned && owned.reason === TENANT_REASON.AMBIGUOUS) {
      _err('You own more than one business. Name the businessId to declare supply for.',
           'failed-precondition');
    }
    _err('No business found for this account.', 'failed-precondition');
  }
  /* Confirm authority over the resolved id too — resolution is not authorization. */
  return await _assertMerchantAuthority(request, owned.merchantId);
}

const setSupplyParticipation = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const { businessId: _requestedBusinessId, supply } = request.data ?? {};

  if (!supply || typeof supply !== 'object' || Array.isArray(supply)) {
    _err('supply must be an object.');
  }
  if (typeof supply.enabled !== 'boolean') {
    _err('supply.enabled must be a boolean — participation is explicit, never inferred.');
  }

  const businessId = await _assertSupplyDeclarationTarget(request, _requestedBusinessId);

  /* Built from the allowlist, never spread — ownerId, adminUids and every other field on
     the business document must be unreachable from this payload. */
  const patch = {};
  for (const key of SUPPLY_MUTABLE) {
    if (!Object.prototype.hasOwnProperty.call(supply, key)) continue;
    const v = supply[key];
    switch (key) {
      case 'enabled':     patch['supply.enabled'] = v === true; break;
      /* THE DISTINCTION AT THE HEART OF DISCOVERY: agreeing to receive business orders is
         not agreeing to be listed in a searchable directory. A business may supply a
         counterparty it already knows without appearing to strangers, so this is its own
         explicit boolean and is never inferred from `enabled`. Opt-in: absent means false. */
      case 'discoverable': patch['supply.discoverable'] = v === true; break;
      case 'displayName': patch['supply.displayName'] = _san(v, 150); break;
      case 'notes':       patch['supply.notes'] = _san(v, 500); break;
      case 'categories': {
        if (!Array.isArray(v)) _err('supply.categories must be an array.');
        patch['supply.categories'] = v.slice(0, 20).map((c) => _san(c, 60));
        break;
      }
      case 'deliveryAreas': {
        if (!Array.isArray(v)) _err('supply.deliveryAreas must be an array.');
        patch['supply.deliveryAreas'] = v.slice(0, 50).map((c) => _san(c, 80));
        break;
      }
      case 'minOrderValue': {
        const num = Number(v);
        if (!isFinite(num) || num < 0) _err('supply.minOrderValue cannot be negative.');
        patch['supply.minOrderValue'] = num;
        break;
      }
      case 'leadDays': {
        const num = Number(v);
        if (!Number.isInteger(num) || num < 0 || num > 365) {
          _err('supply.leadDays must be a whole number of days between 0 and 365.');
        }
        patch['supply.leadDays'] = num;
        break;
      }
    }
  }

  patch['supply.updatedAt'] = F.serverTimestamp();
  patch['supply.updatedBy'] = uid;
  if (supply.enabled === true) {
    patch['supply.enabledAt'] = F.serverTimestamp();
  }
  /* Withdrawing from supply withdraws discovery with it. Leaving a business listed after it
     stopped supplying would advertise a counterparty that no longer accepts orders, and the
     merchant would have no reason to think a second switch was still on. */
  if (supply.enabled === false) {
    patch['supply.discoverable'] = false;
  }

  await db.collection('businesses').doc(businessId).update(patch);

  await _audit(uid, supply.enabled ? 'supply_enabled' : 'supply_disabled', businessId, {
    businessId, fields: Object.keys(patch),
  });
  logger.info('procurement.setSupplyParticipation', { businessId, enabled: supply.enabled });
  return { businessId, enabled: supply.enabled === true };
});

/**
 * Verify that a business may be named as the supplier on a relationship.
 * Existence is not participation: the business must have EXPLICITLY opted in.
 */
async function _assertSuppliesEnabled(supplierBusinessId) {
  const id = String(supplierBusinessId);
  if (!id || id.includes('/') || id.length > 200) {
    _err('A valid supplierBusinessId is required.');
  }
  const snap = await db.collection('businesses').doc(id).get();
  if (!snap.exists) _err('Supplier business not found.', 'not-found');
  const d = snap.data() || {};
  if (!d.supply || d.supply.enabled !== true) {
    _err('That business has not enabled supply and cannot be added as a SOKONI supplier.',
         'failed-precondition');
  }
  return id;
}

/* ════════════════════════════════════════════════════════════════
   1a-2. FIND SUPPLIERS — discovery over SOKONI businesses

   THE TRUST CONTRACT, stated in full because it is deliberately narrow:
       status === 'active'  AND  supply.enabled === true  AND  supply.discoverable === true
   and nothing else. There is no verification badge and no implied vetting.

   WHY NO VERIFICATION CLAIM. A trace of production found no business-level verification to
   claim: `verifications/{uid}` is keyed by USER uid, attests person-level facts (email,
   phone, identity, KRA, address, bank), is EMPTY in production, and its only business-ish
   field is treated as satisfied by merely owning a business. Rendering a 'verified' badge on
   top of that would be a fabricated trust signal — the same defect class removed from
   pos-bi.html. When a real attestation exists it gets its own slice; until then this surface
   makes no claim at all.

   THE ALLOWLIST IS POSITIVE, NOT SUBTRACTIVE. Only the fields named in DISCOVERABLE_FIELDS
   are ever returned. `businesses` documents already carry apiPublicKey and pairingToken —
   credential material on the same document — so a deny-list would leak the next sensitive
   field somebody adds. Phone, email and address are excluded on purpose: a buyer reaches a
   supplier by forming a relationship, not by lifting contact details out of a directory.
════════════════════════════════════════════════════════════════ */

/** The ONLY fields discovery may ever return. Adding one is a privacy decision. */
const DISCOVERABLE_FIELDS = ['businessId', 'name', 'category', 'city', 'county', 'supply'];

/** The supply sub-fields a discovered business exposes — also positive. */
const DISCOVERABLE_SUPPLY_FIELDS = ['displayName', 'categories', 'minOrderValue',
                                    'leadDays', 'deliveryAreas'];

function _projectDiscoverable(id, d) {
  const src = d || {};
  const out = { businessId: id };
  DISCOVERABLE_FIELDS.forEach(function (f) {
    if (f === 'businessId' || f === 'supply') return;
    out[f] = src[f] === undefined ? null : src[f];
  });
  const sup = src.supply || {};
  const supOut = {};
  DISCOVERABLE_SUPPLY_FIELDS.forEach(function (f) {
    supOut[f] = sup[f] === undefined ? null : sup[f];
  });
  out.supply = supOut;
  /* Deliberately absent and never added by omission: phone, email, address, rating,
     products, moq, apiPublicKey, pairingToken, ownerId, adminUids, status. */
  return out;
}

/* ── The audience gate, shared by every read that exposes ANOTHER business ────────
   `_assertMerchantAuthority` honours the owner-uid form and returns WITHOUT a lookup when the
   requested merchant is the caller themselves. That is correct for operating on your own
   data, but on its own it is not an audience gate: it would let ANY signed-in account reach a
   cross-business surface by implicitly acting "for itself". These surfaces are for SOKONI
   businesses, so the viewer must resolve to a real, ACTIVE business document.

   Checked here rather than inside the shared authority primitive, whose behaviour nine other
   operations depend on. ONE helper rather than a copy per surface: an audience gate that
   exists twice is an audience gate that will eventually diverge — which is the whole reason
   this engine exists. The messages stay per-surface so the caller learns what was refused. */
async function _assertActiveBusinessAudience(merchantId, notLinkedMessage, notActiveMessage) {
  const snap = await db.collection('businesses').doc(String(merchantId)).get();
  if (!snap.exists) _err(notLinkedMessage, 'failed-precondition');
  const data = snap.data() || {};
  if (data.status !== 'active') _err(notActiveMessage, 'failed-precondition');
  return data;
}

const findSuppliers = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, category, city, county, limit, cursor } = request.data ?? {};

  /* AUDIENCE. Discovery is for authenticated SOKONI merchants, not the open internet, so the
     caller must prove they act for a business of their own before they may see anyone
     else's. This is the same authority every other procurement operation uses; a signed-in
     account with no merchant relationship is refused. */
  const viewerMerchantId = await _assertMerchantAuthority(request, merchantId);

  await _assertActiveBusinessAudience(viewerMerchantId,
    'Supplier discovery is available to SOKONI businesses. No business is linked to this account.',
    'Supplier discovery requires an active business.');

  /* The three flags are ALL required, and all are equality filters so no composite index is
     introduced. `discoverable` is opt-in: a document without the field does not match. */
  let q = db.collection('businesses')
    .where('status', '==', 'active')
    .where('supply.enabled', '==', true)
    .where('supply.discoverable', '==', true);

  /* Facets are narrowing equality filters only. Free-text search is deliberately NOT here:
     a prefix or array-contains search alongside these filters needs a composite index that
     nobody has decided on, and inventing one silently is how a query starts excluding
     records. It gets its own slice with an explicit index decision. */
  if (category) q = q.where('category', '==', _san(String(category), 100));
  if (city)     q = q.where('city',     '==', _san(String(city), 100));
  if (county)   q = q.where('county',   '==', _san(String(county), 100));

  q = q.orderBy(admin.firestore.FieldPath.documentId());
  if (cursor) q = q.startAfter(_san(String(cursor), 200));

  const cap  = Math.min(Math.max(Number(limit ?? 25), 1), 100);
  const snap = await q.limit(cap + 1).get();
  const docs = snap.docs.slice(0, cap);
  const more = snap.docs.length > cap;

  /* A merchant always sees itself in its own network view only if it opted in like anyone
     else — no special case either way. */
  const suppliers = docs.map(function (d) { return _projectDiscoverable(d.id, d.data()); });

  logger.info('procurement.findSuppliers', {
    viewerMerchantId, count: suppliers.length, category: category || null,
  });

  return {
    viewerMerchantId,
    suppliers,
    count: suppliers.length,
    nextCursor: more ? docs[docs.length - 1].id : null,
    /* Stated in the response so a caller cannot mistake absence of a badge for a claim. */
    verificationClaim: null,
  };
});

/* ════════════════════════════════════════════════════════════════════════════════
   1a-3. SUPPLY CATALOGUE — what one SOKONI business offers another, wholesale

   WHY THIS READ EXISTS AND WHY IT IS NOT getWholesaleCatalog.
   A wholesale engine already exists (b2b-wholesale.js). A trace of it against production
   found it structurally unable to see the real data:

     · it filters `products.wholesaleEnabled == true` — a field set on 0 of 108 production
       products, and written by nothing in the repository except `updateWholesaleProduct`,
       which has ZERO callers anywhere;
     · it reads MOQ from `minOrderQty`, set on 0 products, defaulting to 10 — so every row it
       ever returned would carry an INVENTED minimum order quantity;
     · it renders a missing price as `wholesalePrice || 0`;
     · it gates on `wholesaleAccounts/{uid}.status == 'approved'` — 0 documents exist, so it
       denies every caller on the platform today;
     · its identity space is a user uid, not `businesses/{businessId}`.

   Meanwhile 10 production products DO carry real wholesale terms, published through the
   canonical writer. Repointing that handler would redefine a live-dispatched contract that
   wholesale-portal.html reads; this read is added to the engine that already owns Supply
   instead, and b2b-wholesale.js is left untouched. It is a READ — no orders, no pricing
   engine, no settlement. Not a second commerce engine.

   THE AUTHORITATIVE VOCABULARY, established by trace, not by preference:
     wholesale offered  ⟺  products.wholesalePrice > 0
        sokoni-product-schema.js couples the pair — a price at or below zero nulls BOTH
        wholesalePrice and minWholesaleQty — so a positive price IS the enable flag. There is
        no separate boolean to consult, and inventing one would create a fourth vocabulary.
     minimum order      =  products.minWholesaleQty, or NULL. Never a default. An invented
        MOQ is a term of trade the supplier never agreed to.
     product owner      =  products.sellerUid  (the field firestore.rules enforces; note
        b2b-wholesale.js checks sellerId/uid instead, a divergence recorded, not adopted)
     business identity  =  businesses/{id}.ownerId === products.sellerUid
     availability       =  status / isVisible / outOfStock / stock

   CATALOGUE ACCESS IS NOT DISCOVERY. Reaching a supplier's catalogue requires
   `supply.enabled` — the business agreed to supply others. It does NOT require
   `supply.discoverable`, which is only consent to be FOUND. A business may supply a
   counterparty it already knows while staying out of the directory, so a buyer holding a
   businessId from an existing relationship can read the catalogue of a supplier that Slice
   K's search will never return. Collapsing the two would silently revoke that.
════════════════════════════════════════════════════════════════════════════════ */

/** The ONLY product fields the catalogue may ever return. Adding one is a privacy decision. */
const CATALOGUE_FIELDS = ['productId', 'name', 'category', 'wholesalePrice', 'minWholesaleQty',
                          'retailPrice', 'inStock', 'image', 'description',
                          'supplierBusinessId', 'supplierName'];

/* How many documents one page may examine. The wholesale predicate is applied in memory
   (see the query note below), so a page can scan more products than it returns. */
const CATALOGUE_SCAN = 120;

/** A finite, positive number, or null. Anything else — string, NaN, 0, negative — is NOT a
    price and must never be presented as one. */
function _positiveNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Availability WITHOUT revealing inventory depth. Exact stock is a competitor's dream and is
 * never returned. A product that carries no availability signal at all resolves to null —
 * unknown — and never to `false`, which would wrongly advertise it as sold out, nor to
 * `true`, which would promise stock nobody recorded.
 */
function _availability(d) {
  if (d.outOfStock === true) return false;
  const n = typeof d.stock === 'number' ? d.stock : Number(d.stock);
  if (Number.isFinite(n)) return n > 0;
  if (d.outOfStock === false) return true;
  return null;
}

/**
 * A product is a catalogue entry only if the supplier actually offers it wholesale AND it is
 * live on the marketplace. Every clause is a positive requirement: a document missing the
 * field fails the test rather than passing by default.
 */
function _isCatalogueEntry(d) {
  if (_positiveNumber(d.wholesalePrice) === null) return false;
  if (d.status !== 'active') return false;
  if (d.isVisible === false) return false;
  return true;
}

function _projectCatalogueEntry(id, d, supplierBusinessId, supplierName) {
  const src = d || {};
  return {
    productId:          id,
    name:               src.name === undefined ? null : src.name,
    category:           src.category === undefined ? null : src.category,
    /* Authoritative and coupled by the schema. */
    wholesalePrice:     _positiveNumber(src.wholesalePrice),
    /* NULL when the supplier set none. Never MIN_ITEM_QTY, never 1, never 10. */
    minWholesaleQty:    _positiveNumber(src.minWholesaleQty),
    /* Already world-readable on the marketplace, so this reveals nothing new. No saving or
       discount percentage is computed here: a derived figure presented next to real ones
       reads as authoritative, and the buyer can do the subtraction. */
    retailPrice:        _positiveNumber(src.price),
    inStock:            _availability(src),
    image:              src.image || (Array.isArray(src.images) ? src.images[0] : null) || null,
    description:        _san(src.description || '', 500) || null,
    supplierBusinessId: supplierBusinessId,
    supplierName:       supplierName === undefined ? null : supplierName,
    /* Deliberately absent and never added by omission: costPrice (the supplier's margin),
       sellerEmail, sellerUid, uid, shopId, totalRevenue, totalUnitsSold, sold,
       lastSaleOrderId, lastSoldAt, stock (the exact quantity), digitalUrl, digitalLicense,
       verificationStatus, _testPricedBy, _ownerNormalizedFrom. */
  };
}

const getSupplyCatalogue = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, supplierBusinessId, category, limit, cursor } = request.data ?? {};

  const viewerMerchantId = await _assertMerchantAuthority(request, merchantId);
  await _assertActiveBusinessAudience(viewerMerchantId,
    'The supply catalogue is available to SOKONI businesses. No business is linked to this account.',
    'Reading a supply catalogue requires an active business.');

  /* Omitted supplier means "my own catalogue" — what this business offers others. That is a
     view of your own data, so it needs no supply participation: you may always see what you
     are offering, including that you are offering nothing. */
  const supplierId = supplierBusinessId ? _san(String(supplierBusinessId), 200) : viewerMerchantId;
  const isOwnCatalogue = supplierId === viewerMerchantId;

  const supplierSnap = await db.collection('businesses').doc(String(supplierId)).get();
  if (!supplierSnap.exists) {
    /* A forged or stale businessId resolves to nothing. It cannot widen authority: the
       viewer's own gate has already passed independently of this value, and nothing below
       reads a client-supplied owner. */
    _err('That business is not on SOKONI.', 'not-found');
  }
  const supplier = supplierSnap.data() || {};

  if (supplier.status !== 'active') {
    _err('That business is not active on SOKONI.', 'failed-precondition');
  }
  if (!isOwnCatalogue && ((supplier.supply || {}).enabled !== true)) {
    /* Participation is required to show a business's terms to a DIFFERENT business.
       Discoverability is deliberately NOT required — see the header. */
    _err('That business does not supply other businesses.', 'failed-precondition');
  }

  /* The canonical bridge: a business's wholesale offers are its OWNER's marketplace products.
     ownerId is read from the business document the server just fetched — never from the
     request — so a client cannot point the query at somebody else's products. */
  const ownerUid = supplier.ownerId;
  if (!ownerUid) {
    _err('That business has no canonical owner, so its catalogue cannot be resolved.',
         'failed-precondition');
  }

  /* ONE equality filter, ordered by document id. The wholesale predicate is applied in memory
     on purpose: `where('sellerUid','==',x).where('wholesalePrice','>',0)` mixes an equality
     and an inequality on different fields, which REQUIRES a composite index. Deployment is on
     hold, so such a query would simply fail in production — and adding an index silently is
     how a catalogue starts omitting products nobody can explain. The cost is that a page
     scans more documents than it returns, which is reported honestly as `scanned`. */
  let q = db.collection('products').where('sellerUid', '==', String(ownerUid));
  q = q.orderBy(admin.firestore.FieldPath.documentId());
  if (cursor) q = q.startAfter(_san(String(cursor), 200));

  const snap = await q.limit(CATALOGUE_SCAN).get();
  const wantCategory = category ? _san(String(category), 100) : null;

  const products = [];
  snap.docs.forEach(function (doc) {
    const d = doc.data() || {};
    if (!_isCatalogueEntry(d)) return;
    if (wantCategory && d.category !== wantCategory) return;
    products.push(_projectCatalogueEntry(doc.id, d, supplierId, supplier.name || null));
  });

  const cap = Math.min(Math.max(Number(limit ?? 50), 1), 100);
  const page = products.slice(0, cap);

  /* The cursor advances by the last document SCANNED, not the last one returned. Advancing by
     a returned row would skip every non-wholesale product between it and the next match. */
  const scanned = snap.docs.length;
  const exhausted = scanned < CATALOGUE_SCAN && page.length === products.length;
  const nextCursor = exhausted ? null : (snap.docs.length ? snap.docs[snap.docs.length - 1].id : null);

  logger.info('procurement.getSupplyCatalogue', {
    viewerMerchantId, supplierId, own: isOwnCatalogue, scanned, returned: page.length,
  });

  return {
    viewerMerchantId,
    supplierBusinessId: supplierId,
    supplierName: supplier.name || null,
    isOwnCatalogue,
    products: page,
    count: page.length,
    /* Reported so an empty page with a cursor reads as "more to scan", not "nothing exists". */
    scanned,
    nextCursor,
    /* Same honesty marker as discovery: no vetting is claimed by this surface. */
    verificationClaim: null,
  };
});

/* ════════════════════════════════════════════════════════════════
   1b. updateSupplier
   Edit a supplier the caller is authorized for. Ownership and derived state are
   server-controlled and cannot be moved by a client payload.
════════════════════════════════════════════════════════════════ */

/* The ONLY fields a client may change. Everything else on the document — supplierId,
   merchantId, currentBalance, rating, createdBy, createdAt — is either identity or
   server-derived state, and is unreachable from here by construction: the update object
   is BUILT from this list, never spread from the payload. */
const SUPPLIER_MUTABLE = ['name', 'contactName', 'phone', 'email', 'kraPin',
                          'bankDetails', 'paymentTerms', 'creditLimit', 'status',
                          /* the SOKONI counterparty link — verified, never merged blind */
                          'supplierBusinessId'];

const updateSupplier = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const { supplierId, updates } = request.data ?? {};

  if (!supplierId) _err('supplierId is required.');
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    _err('updates must be an object.');
  }

  /* Read the supplier FIRST, then authorize against the merchantId ON THE DOCUMENT —
     never one supplied by the caller. Authorizing against a payload merchantId would let
     a caller name their own merchant while addressing someone else's supplier. */
  const ref  = db.collection('procSuppliers').doc(String(supplierId));
  const snap = await ref.get();
  if (!snap.exists) _err('Supplier not found.', 'not-found');
  const existing = snap.data() || {};

  await _assertMerchantAuthority(request, existing.merchantId);

  /* Build the patch from the allowlist. An unknown or immutable key is ignored, not
     merged — so a payload carrying merchantId, currentBalance or createdBy changes
     nothing rather than silently taking effect. */
  const patch = {};
  for (const key of SUPPLIER_MUTABLE) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    const v = updates[key];

    switch (key) {
      case 'name': {
        if (!v) _err('Supplier name cannot be empty.');
        patch.name = _san(v, MAX_SUPPLIER_NAME);
        break;
      }
      case 'phone': {
        if (!v) _err('Contact phone cannot be empty.');
        patch.phone = _san(v, 20);
        break;
      }
      case 'contactName': patch.contactName = _san(v, 150); break;
      case 'email':       patch.email       = _san(v, 150); break;
      case 'kraPin': {
        if (v === null || v === '') { patch.kraPin = null; break; }
        const KRA_RE = /^[A-Z]d{9}[A-Z]$/;
        const norm = String(v).trim().toUpperCase();
        if (!KRA_RE.test(norm)) _err('Invalid KRA PIN format. Expected: A123456789B');
        patch.kraPin = norm;
        break;
      }
      case 'bankDetails':
        patch.bankDetails = v ? _san(JSON.stringify(v), 500) : null;
        break;
      case 'paymentTerms': {
        const VALID_TERMS = new Set([7, 14, 30, 45, 60, 90]);
        const termDays = Number(v);
        if (!VALID_TERMS.has(termDays)) {
          _err('paymentTerms must be one of: 7, 14, 30, 45, 60, 90 (days).');
        }
        patch.paymentTerms = termDays;
        break;
      }
      case 'creditLimit': {
        const limit = Number(v);
        if (!isFinite(limit) || limit < 0) _err('creditLimit cannot be negative.');
        patch.creditLimit = limit;
        break;
      }
      case 'status': {
        if (!['active', 'inactive'].includes(v)) {
          _err("status must be 'active' or 'inactive'.");
        }
        patch.status = v;
        break;
      }
      case 'supplierBusinessId': {
        /* Clearing the link is always allowed; setting one is verified the same way
           addSupplier verifies it — existence is not participation. */
        if (v === null || v === '') { patch.supplierBusinessId = null; break; }
        patch.supplierBusinessId = await _assertSuppliesEnabled(v);
        break;
      }
    }
  }

  if (Object.keys(patch).length === 0) _err('No updatable fields supplied.');

  patch.updatedAt = F.serverTimestamp();
  patch.updatedBy = uid;

  await ref.update(patch);

  await _audit(uid, 'supplier_updated', String(supplierId), {
    merchantId: existing.merchantId, fields: Object.keys(patch),
  });

  logger.info('procurement.updateSupplier', {
    supplierId, merchantId: existing.merchantId, fields: Object.keys(patch),
  });
  return { supplierId: String(supplierId), updated: Object.keys(patch) };
});

/**
 * PO-DERIVED BUYER AUTHORITY — the gate for every operation that acts on an existing
 * purchase order.
 *
 * The merchant is read off the AUTHORITATIVE document, never from the request. A caller
 * naming a poId is naming a document; the document says whose it is. So a forged
 * merchantId, supplierId or supplierBusinessId in the payload is simply irrelevant here —
 * there is nothing for it to influence.
 *
 * Fails closed on a missing PO: an unknown order is not an open one.
 *
 * Role is not tenancy. `_requireManager` proves a caller holds a manager claim; it never
 * proves they hold it FOR THIS MERCHANT. Operations that need both compose them — the role
 * gate first, then this.
 *
 * @returns {Promise<{poRef, po, merchantId}>}
 */
async function _assertPoAuthority(request, poId) {
  if (!poId) _err('poId is required.');

  const poRef  = db.collection('procPurchaseOrders').doc(String(poId));
  const poSnap = await poRef.get();
  if (!poSnap.exists) _err('Purchase order not found.', 'not-found');

  const po = poSnap.data() || {};
  /* buyerBusinessId (Slice B) is the forward-looking field; merchantId is retained for
     compatibility and is what every existing document carries. Either identifies the
     BUYER — the party whose order this is. */
  const owner = po.buyerBusinessId || po.merchantId;
  if (!owner) {
    /* A PO with no owner cannot be authorized against anything. Refuse rather than
       fall through to a permissive default. */
    _err('Purchase order has no owning merchant.', 'failed-precondition');
  }

  const merchantId = await _assertMerchantAuthority(request, String(owner));
  return { poRef, po, merchantId };
}

/* ════════════════════════════════════════════════════════════════
   1c. SUPPLIER-SIDE AUTHORITY — deliberately NOT the buyer-side check.

   Buyer authority answers "may this caller act as merchant X". Supplier authority answers
   "may this caller act as the SUPPLYING business on this order". They must never collapse:
   a purchase order is two businesses' data, and being authorized for the buyer must not
   confer sight of the supplier's book, or the reverse.

   The resolution differs materially, not just nominally. _assertMerchantAuthority honours
   the owner-uid form without a lookup, so a caller whose uid is a merchantId short-circuits
   to THAT identity. Production has an owner with two simultaneously active businesses
   (census 2026-09-04), so a supplier-side query resolved from the caller's uid would answer
   for the uid-keyed business and MISS orders addressed to their generated-id business.
   Supplier-side authority therefore always resolves from the ORDER's supplierBusinessId and
   verifies the caller against that business.
════════════════════════════════════════════════════════════════ */
async function _assertSupplierSideAuthority(request, supplierBusinessId) {
  const auth = request && request.auth;
  if (!auth || !auth.uid) _err('Authentication required.', 'unauthenticated');
  if (!supplierBusinessId) {
    _err('This order has no SOKONI supplier business.', 'failed-precondition');
  }
  /* Authority over the SUPPLIER business specifically — never the caller's own merchant. */
  return await _assertMerchantAuthority(request, String(supplierBusinessId));
}

/**
 * The supplying business's own view of inbound supply orders — "Business Orders" /
 * "Orders to Fulfil". Scoped by supplierBusinessId, authorized supplier-side.
 */
const getInboundSupplyOrders = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { supplierBusinessId, status, limit } = request.data ?? {};

  const businessId = await _assertSupplierSideAuthority(request, supplierBusinessId);

  let q = db.collection('procPurchaseOrders').where('supplierBusinessId', '==', businessId);
  if (status) q = q.where('status', '==', String(status));
  const cap = Math.min(Math.max(Number(limit ?? 50), 1), 200);

  const snap = await q.limit(cap).get();
  const orders = snap.docs.map((d) => {
    const p = d.data() || {};
    /* The supplier sees the order, not the buyer's whole book. */
    return {
      poId: p.poId, poNumber: p.poNumber, status: p.status,
      buyerBusinessId: p.buyerBusinessId || p.merchantId || null,
      items: p.items, subtotal: p.subtotal, vatAmount: p.vatAmount, total: p.total,
      expectedDelivery: p.expectedDelivery || null,
      sentAt: p.sentAt || null, createdAt: p.createdAt || null,
    };
  });

  logger.info('procurement.getInboundSupplyOrders', { businessId, count: orders.length });
  return { supplierBusinessId: businessId, count: orders.length, orders };
});

/* ════════════════════════════════════════════════════════════════
   1d. THE SCOPED READ LAYER (Slice I)

   Every procurement read is tenant data. One primitive, not six near-copies: a second
   hand-written scoping query is how one of them ends up missing its filter, and a read that
   forgets its filter leaks another merchant's suppliers, orders, payables and stock.

   THE SCOPE IS NEVER THE CALLER'S TO CHOOSE. `merchantId` arrives as a REQUEST; the value
   actually queried is the one `_assertMerchantAuthority` returns. A forged merchantId,
   supplierId or businessId in the payload therefore has nothing to influence.

   PAGINATION CANNOT WIDEN THE SCOPE. The merchant filter is applied before the cursor, and
   the cursor is only ever a document id passed to startAfter within that already-filtered
   query — so a cursor lifted from another merchant's result set cannot reach across. Counts
   are computed from the same filtered query, never from a collection-wide aggregate.

   Ordering is by document id deliberately. A createdAt ordering would silently EXCLUDE any
   legacy document missing that field, and would need composite indexes this slice is not
   authorised to add. Time-ordered views are a follow-up with an explicit index decision.
════════════════════════════════════════════════════════════════ */

const _MAX_PAGE = 200;

/**
 * Read one page of a merchant-owned collection.
 *
 * @param {object} request   the callable request (authority comes from here, not the args)
 * @param {string} collection
 * @param {object} [opts]    { requested, equals: {field:value}, limit, cursor, project }
 * @returns {Promise<{merchantId, items, nextCursor, count}>}
 */
async function _listScoped(request, collection, opts) {
  const o = opts || {};
  /* AUTHORITY FIRST. Everything below queries the value this returns. */
  const merchantId = await _assertMerchantAuthority(request, o.requested);

  let q = db.collection(collection).where('merchantId', '==', merchantId);

  /* Additional equality filters are narrowing only — they can never widen past the
     merchant filter above, which is applied first and unconditionally. */
  const eq = o.equals || {};
  for (const field of Object.keys(eq)) {
    const v = eq[field];
    if (v === undefined || v === null || v === '') continue;
    q = q.where(field, '==', typeof v === 'string' ? _san(v, 200) : v);
  }

  q = q.orderBy(admin.firestore.FieldPath.documentId());

  if (o.cursor) {
    /* A cursor is a position WITHIN the caller's own filtered result set. Because the
       merchant filter is already applied, a cursor taken from another merchant's page can
       only skip forward inside this caller's own data — never reach into theirs. */
    q = q.startAfter(_san(String(o.cursor), 200));
  }

  const limit = Math.min(Math.max(Number(o.limit ?? 50), 1), _MAX_PAGE);
  const snap  = await q.limit(limit + 1).get();

  const docs = snap.docs.slice(0, limit);
  const more = snap.docs.length > limit;

  const items = docs.map((d) => {
    const data = d.data() || {};
    return o.project ? o.project(data, d.id) : Object.assign({ id: d.id }, data);
  });

  return {
    merchantId,
    items,
    count: items.length,          /* of THIS page, from the filtered query */
    nextCursor: more ? docs[docs.length - 1].id : null,
  };
}

/** Suppliers for this merchant — both SOKONI counterparties and external ones. */
const listSuppliers = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, status, limit, cursor } = request.data ?? {};
  const page = await _listScoped(request, 'procSuppliers', {
    requested: merchantId, equals: { status }, limit, cursor,
    project: (d, id) => ({
      supplierId: d.supplierId || id,
      name: d.name || null, contactName: d.contactName || null,
      phone: d.phone || null, email: d.email || null,
      /* The SOKONI counterparty when there is one; null for a genuinely external supplier. */
      supplierBusinessId: d.supplierBusinessId || null,
      isSokoniBusiness: !!d.supplierBusinessId,
      paymentTerms: d.paymentTerms ?? null, creditLimit: d.creditLimit ?? null,
      currentBalance: d.currentBalance ?? 0, rating: d.rating ?? 0,
      status: d.status || null, createdAt: d.createdAt || null,
    }),
  });
  return page;
});

const listPurchaseOrders = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, status, supplierId, limit, cursor } = request.data ?? {};
  return await _listScoped(request, 'procPurchaseOrders', {
    requested: merchantId, equals: { status, supplierId }, limit, cursor,
    project: (d, id) => ({
      poId: d.poId || id, poNumber: d.poNumber || null, status: d.status || null,
      supplierId: d.supplierId || null, supplierName: d.supplierName || null,
      supplierBusinessId: d.supplierBusinessId || null,
      buyerBusinessId: d.buyerBusinessId || d.merchantId || null,
      itemCount: Array.isArray(d.items) ? d.items.length : 0,
      subtotal: d.subtotal ?? null, vatAmount: d.vatAmount ?? null, total: d.total ?? null,
      expectedDelivery: d.expectedDelivery || null, approvedAt: d.approvedAt || null,
      sentAt: d.sentAt || null, delivery: d.delivery || null, createdAt: d.createdAt || null,
    }),
  });
});

const listGRNs = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, poId, limit, cursor } = request.data ?? {};
  return await _listScoped(request, 'procGRN', {
    requested: merchantId, equals: { poId }, limit, cursor,
    project: (d, id) => ({
      grnId: d.grnId || id, poId: d.poId || null, supplierId: d.supplierId || null,
      branchId: d.branchId || null, totalReceived: d.totalReceived ?? 0,
      discrepancyCount: Array.isArray(d.discrepancies) ? d.discrepancies.length : 0,
      poStatusAfter: d.poStatusAfter || null, receivedBy: d.receivedBy || null,
      receivedAt: d.receivedAt || null,
    }),
  });
});

const listSupplierInvoices = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, status, supplierId, limit, cursor } = request.data ?? {};
  return await _listScoped(request, 'procSupplierInvoices', {
    requested: merchantId, equals: { status, supplierId }, limit, cursor,
    project: (d, id) => ({
      invoiceId: d.invoiceId || id, invoiceNumber: d.invoiceNumber || null,
      poId: d.poId || null, grnId: d.grnId || null, supplierId: d.supplierId || null,
      amount: d.amount ?? null, vatAmount: d.vatAmount ?? null, total: d.total ?? null,
      status: d.status || null, dueDate: d.dueDate || null,
      /* paidAt records a BOOKKEEPING entry, not a transfer of funds. */
      paidAt: d.paidAt || null, paymentMethod: d.paymentMethod || null,
      createdAt: d.createdAt || null,
    }),
  });
});

/** Warehouse stock. Scoped by merchantId — the same field business-health-score and
    business-bootstrap already query posProducts on. */
const listWarehouseStock = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, branchId, limit, cursor } = request.data ?? {};
  return await _listScoped(request, 'posProducts', {
    requested: merchantId, equals: { branchId }, limit, cursor,
    project: (d, id) => ({
      id, productId: d.productId || null, name: d.name || null, sku: d.sku || null,
      branchId: d.branchId || null,
      stockQty: d.stockQty ?? null,      /* null means UNKNOWN, never 0 */
      reorderPoint: d.reorderPoint ?? null, costPrice: d.costPrice ?? null,
      supplierId: d.supplierId || null, updatedAt: d.updatedAt || null,
    }),
  });
});

/** Stock movements — the audit trail receiveGoods writes alongside every stock change. */
const listStockMovements = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { merchantId, productId, branchId, type, limit, cursor } = request.data ?? {};
  return await _listScoped(request, 'stockMovements', {
    requested: merchantId, equals: { productId, branchId, type }, limit, cursor,
    project: (d, id) => ({
      id, type: d.type || null, productId: d.productId || null, branchId: d.branchId || null,
      qty: d.qty ?? null, unitCost: d.unitCost ?? null,
      refType: d.refType || null, refId: d.refId || null,
      poId: d.poId || null, supplierId: d.supplierId || null,
      performedBy: d.performedBy || null, createdAt: d.createdAt || null,
    }),
  });
});
/* ════════════════════════════════════════════════════════════════
   2. createPurchaseOrder
   Draft a purchase order against a supplier.
════════════════════════════════════════════════════════════════ */
const createPurchaseOrder = onCall(OPT, async (request) => {
  const uid = _requireAuth(request);
  const {
    merchantId: _requestedMerchantId, supplierId, items,
    notes, expectedDelivery,
  } = request.data ?? {};

  if (!supplierId)  _err('supplierId is required.');

  /* The old check compared supplier.merchantId against the CALLER-SUPPLIED merchantId —
     self-referential, so supplying merchant B's id with one of B's suppliers passed. It
     proved supplier<->merchant consistency and never caller<->merchant authority. */
  const merchantId = await _assertMerchantAuthority(request, _requestedMerchantId);

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

    /* ── Merchant-to-merchant supply (additive, Slice B) ───────────────────────────
       businesses/{id} is the ONE canonical identity in SOKONI. A supplier may itself be
       a SOKONI merchant, in which case the counterparty has a canonical business id and
       must not be duplicated as a separate supplier identity.

       Nullable and additive on purpose: merchantId/supplierId keep working unchanged, so
       nothing migrates, and the canonical PO shape can already carry a business-to-business
       relationship when Slice B2 populates it.

       buyerBusinessId is the AUTHORIZED merchantId — the value the authority primitive
       returned, never the payload's. supplierBusinessId is read off the supplier RECORD,
       never accepted from the caller: a client asserting "this PO supplies business X"
       would be asserting a relationship it has no authority to declare. Slice B2 adds the
       verification (business exists AND has opted into supply) that lets it be set at all;
       until then it is whatever the supplier record already carries, or null. */
    buyerBusinessId:    merchantId,
    supplierBusinessId: supplier.supplierBusinessId || null,
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
   2b. getPurchaseOrder
   Read one canonical purchase order. Added for Slice G: a device-local record may carry a
   procPoId, and reconciliation must VERIFY that against the server rather than trusting it.
   A local id must never be mistaken for a canonical one, and a canonical id that does not
   resolve must not be reported to a merchant as a submitted order.

   Merchant-scoped through the same PO-derived gate as approve/send/receive, so this cannot
   become a way to enumerate another merchant's orders.
════════════════════════════════════════════════════════════════ */
const getPurchaseOrder = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { poId } = request.data ?? {};

  const { po } = await _assertPoAuthority(request, poId);

  return {
    poId:               po.poId,
    poNumber:           po.poNumber,
    status:             po.status,
    merchantId:         po.merchantId,
    buyerBusinessId:    po.buyerBusinessId || po.merchantId || null,
    supplierId:         po.supplierId,
    supplierBusinessId: po.supplierBusinessId || null,
    supplierName:       po.supplierName || null,
    items:              po.items || [],
    subtotal:           po.subtotal,
    vatAmount:          po.vatAmount,
    total:              po.total,
    expectedDelivery:   po.expectedDelivery || null,
    approvedAt:         po.approvedAt || null,
    sentAt:             po.sentAt || null,
    delivery:           po.delivery || null,
    createdAt:          po.createdAt || null,
  };
});
/* ════════════════════════════════════════════════════════════════
   3. approvePurchaseOrder
   Manager or admin: approve (→ 'approved') or reject (→ 'cancelled').
════════════════════════════════════════════════════════════════ */
const approvePurchaseOrder = onCall(OPT, async (request) => {
  /* BOTH gates, composed. The manager claim is retained unchanged — approval is still a
     manager/admin action. What it never established is WHICH merchant, so a manager at one
     merchant could approve another's order. _assertPoAuthority closes that by reading the
     owner off the PO itself. */
  const uid = _requireManager(request);
  const { poId, approved, notes } = request.data ?? {};

  if (typeof approved !== 'boolean') _err('approved must be a boolean.');

  const { poRef, po } = await _assertPoAuthority(request, poId);
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

  /* Merchant scoping added (Slice C). Previously this required only that the caller was
     signed in, so any authenticated user could send any merchant's purchase order to its
     supplier. The delivery abstraction below is deliberately untouched: the same
     emailSvc.queue + notify.notify routing, the same deterministic po-sent-{poId} email id,
     the same honest per-channel delivery record. This slice changes WHO may call it, not
     what it does. */
  const { poRef, po } = await _assertPoAuthority(request, poId);
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
    poId, branchId, items, receivedBy, receiptKey,
  } = request.data ?? {};

  if (!branchId) _err('branchId is required.');
  if (!Array.isArray(items) || items.length === 0) _err('items array is required.');

  /* MERCHANT SCOPING (Slice D). Previously this required only that the caller was signed
     in, so any authenticated user could record receipt against any merchant's purchase
     order — and receipt increments inventory and creates a payable. The buyer is derived
     from the authoritative PO document, so a forged merchantId/supplierId in the payload
     has nothing to influence.

     Note this is BUYER-side authority deliberately. Being the SUPPLIER on a PO does not
     entitle you to record that the buyer received the goods; that is the buyer's assertion
     about their own warehouse. Slice B2's supplier-side path is separate and does not
     reach here. */
  const { poRef, po } = await _assertPoAuthority(request, poId);

  /* The receivable-state gate deliberately lives INSIDE the transaction below, AFTER the
     idempotency check — not here. Checking it first meant that retrying the very receipt
     which closed the order was rejected with "cannot receive in status 'received'" rather
     than recognised as the duplicate it is. A retry must be idempotent regardless of the
     state its own original write produced. */

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

  /* Compute discrepancies against what was ORDERED. Over-receipt is deliberately
     PERMITTED by this contract - a supplier who ships 12 against an order of 10 has not
     committed an error the system should refuse; it is recorded as a discrepancy so a human
     can reconcile it. Changing that is a product decision, not a hardening. */
  const discrepancies = [];
  for (const it of cleanReceived) {
    if (it.receivedQty !== it.orderedQty || it.condition !== 'good') {
      discrepancies.push({
        productId:   it.productId,
        orderedQty:  it.orderedQty,
        receivedQty: it.receivedQty,
        condition:   it.condition,
      });
    }
  }
  const allGoodItems  = cleanReceived.filter(it => it.condition === 'good');
  const totalReceived = allGoodItems.reduce((sum, it) => sum + it.receivedQty, 0);

  /* -- IDEMPOTENCY ---------------------------------------------------------------
     The GRN id is DERIVED, not minted. Submitting the same receipt twice - a double
     click, a retried request after a timeout, an offline queue replaying - must record
     one receipt and move stock once.

     `receiptKey` lets a client distinguish two genuinely separate receipts of the same
     items against the same PO (receiving 5 today and 5 more tomorrow): give each
     receiving session its own key. Omit it and the key is the payload itself, so an
     identical resubmission is treated as the same receipt - the safe default.

     The check lives INSIDE the transaction, so two concurrent submissions cannot both
     observe "no GRN yet" and both write: the loser's read is invalidated and it retries,
     then sees the winner's document and returns it. Sequential retry and concurrent
     duplicate therefore have the same outcome, which sequential-only testing would not
     establish. */
  const itemFingerprint = cleanReceived
    .map(it => it.productId + ':' + it.receivedQty + ':' + it.condition)
    .sort()
    .join('|');
  const keySeed = receiptKey
    ? poId + '|key|' + _san(String(receiptKey), 120)
    : poId + '|' + _san(branchId, 100) + '|' + itemFingerprint;
  const grnId = _deterministicId(keySeed, 'grn');

  /* -- ONE ATOMIC UNIT -----------------------------------------------------------
     GRN + PO state + stock + stock movement still succeed or fail together. A
     transaction rather than a batch, because the idempotency check is a READ that the
     writes depend on - a batch cannot express that. All reads precede all writes. */
  const result = await db.runTransaction(async (t) => {
    const grnRef  = db.collection('procGRN').doc(grnId);
    const grnSnap = await t.get(grnRef);

    /* Already recorded: return the ORIGINAL outcome. No second GRN, no second
       increment, no error - a retry is not a failure. */
    if (grnSnap.exists) {
      const prior = grnSnap.data() || {};
      return {
        grnId,
        totalReceived: prior.totalReceived != null ? prior.totalReceived : 0,
        discrepancies: prior.discrepancies || [],
        poStatus:      prior.poStatusAfter || null,
        duplicate:     true,
      };
    }

    /* Re-read the PO inside the transaction: its cumulative quantities may have moved
       since the authority check, and the aggregate below must be computed from the
       state we are actually writing against. */
    const poTxSnap = await t.get(poRef);
    if (!poTxSnap.exists) _err('Purchase order not found.', 'not-found');
    const poNow = poTxSnap.data() || {};
    if (!['sent', 'partially_received'].includes(poNow.status)) {
      _err("Cannot receive goods for a PO in status '" + poNow.status + "'.");
    }

    /* -- CUMULATIVE receipt state ------------------------------------------------
       The status is derived from every receipt so far, not from this one. Previously
       `totalReceivedGood >= totalOrderedQty` compared THIS receipt against the whole
       order, so two partial receipts of 5 against an order of 10 both reported
       'partially_received' and the PO never reached 'received'. Received quantities now
       accumulate on the PO's own items, which is also what makes a partial receipt
       followed by its remainder close the order correctly. */
    const receivedNow = {};
    for (const it of allGoodItems) {
      receivedNow[it.productId] = (receivedNow[it.productId] || 0) + it.receivedQty;
    }
    const updatedItems = (poNow.items || []).map((it) => {
      const add = receivedNow[it.productId] || 0;
      return add ? Object.assign({}, it, { receivedQty: (Number(it.receivedQty) || 0) + add }) : it;
    });
    const totalOrderedQty  = updatedItems.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
    const totalReceivedCum = updatedItems.reduce((sum, it) => sum + (Number(it.receivedQty) || 0), 0);
    const newPoStatus = totalReceivedCum >= totalOrderedQty ? 'received' : 'partially_received';

    /* -- writes -- */
    const now = F.serverTimestamp();

    t.set(grnRef, {
      grnId,
      poId,
      merchantId:    poNow.merchantId,
      supplierId:    poNow.supplierId,
      branchId:      _san(branchId, 100),
      items:         cleanReceived,
      totalReceived,
      discrepancies,
      poStatusAfter: newPoStatus,   /* so a duplicate can return the original outcome */
      receiptKey:    receiptKey ? _san(String(receiptKey), 120) : null,
      receivedBy:    _san(receivedBy || uid, 150),
      receivedByUid: uid,
      receivedAt:    now,
      createdAt:     now,
    });

    t.update(poRef, {
      items:     updatedItems,
      status:    newPoStatus,
      updatedAt: now,
    });

    for (const it of allGoodItems) {
      if (it.receivedQty <= 0) continue;

      /* set-with-merge, NOT update. A first-ever receipt of a product this branch has
         never stocked has no posProducts document, and `update` on a missing document
         rejects the ENTIRE transaction - so the first legitimate receipt failed, and took
         the GRN and the PO status down with it. increment() creates the field from zero
         under set-merge. */
      const productRef = db.collection('posProducts').doc(branchId + '_' + it.productId);
      t.set(productRef, {
        productId:  it.productId,
        branchId:   _san(branchId, 100),
        merchantId: poNow.merchantId,
        stockQty:   F.increment(it.receivedQty),
        updatedAt:  now,
      }, { merge: true });

      const movRef = db.collection('stockMovements').doc();
      t.set(movRef, {
        type:       'procurement_receipt',
        productId:  it.productId,
        branchId:   _san(branchId, 100),
        merchantId: poNow.merchantId,
        qty:        it.receivedQty,
        unitCost:   it.unitCost,
        refType:    'grn',
        refId:      grnId,
        poId,
        supplierId: poNow.supplierId,
        performedBy: uid,
        createdAt:  now,
      });
    }

    return { grnId, totalReceived, discrepancies, poStatus: newPoStatus, duplicate: false };
  });

  if (!result.duplicate) {
    await _audit(uid, 'grn_created', grnId, {
      poId, merchantId: po.merchantId, totalReceived, discrepancyCount: discrepancies.length,
    });
  }

  logger.info('procurement.receiveGoods', {
    grnId, poId, poStatus: result.poStatus, totalReceived: result.totalReceived,
    duplicate: result.duplicate,
  });
  return result;
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

  if (!invoiceNumber) _err('invoiceNumber is required.');

  /* MERCHANT SCOPING (Slice E). Previously only _requireAuth, so any authenticated user
     could raise an invoice against any merchant's purchase order — a payable created on
     someone else's books. The buyer is derived from the authoritative PO. */
  const { po } = await _assertPoAuthority(request, poId);

  if (['draft', 'pending_approval', 'cancelled'].includes(po.status)) {
    _err(`Cannot create invoice for a PO in status '${po.status}'.`);
  }

  /* Validate amounts */
  const invAmount    = _posNum(amount, 'Invoice amount');
  const invVat       = Number(vatAmount ?? 0);
  const invTotal     = +(invAmount + invVat).toFixed(2);

  /* Warn if invoice total deviates from PO total by more than 5% */
  /* A zero-total PO made this NaN, and `NaN > 0.05` is false — so the tolerance check
     silently passed for any invoice amount. Guarded explicitly. */
  const poTotal = Number(po.total) || 0;
  if (poTotal <= 0) _err('Cannot invoice against a purchase order with no total.');
  const deviation = Math.abs(invTotal - poTotal) / poTotal;
  if (deviation > 0.05) {
    _err(`Invoice total KES ${invTotal.toLocaleString()} deviates more than 5% from PO total KES ${poTotal.toLocaleString()}. Raise a dispute with the supplier.`);
  }

  /* ── WHICH GRNs MAY BE REFERENCED ────────────────────────────────────────────────
     grnId was accepted and sanitised but never verified, so an invoice could cite any
     string — including another merchant's GRN, or one belonging to a different PO. A
     receipt reference that nobody checks is worse than none: it looks like provenance.
     If cited, the GRN must exist, belong to THIS purchase order, and to the same
     merchant. */
  let verifiedGrnId = null;
  if (grnId) {
    const gSnap = await db.collection('procGRN').doc(_san(String(grnId), 100)).get();
    if (!gSnap.exists) _err('Referenced GRN not found.', 'not-found');
    const g = gSnap.data() || {};
    if (g.poId !== poId) _err('Referenced GRN belongs to a different purchase order.');
    if (g.merchantId && po.merchantId && g.merchantId !== po.merchantId) {
      _err('Referenced GRN belongs to a different merchant.', 'permission-denied');
    }
    verifiedGrnId = gSnap.id;
  }

  /* ── DUPLICATE INVOICE ───────────────────────────────────────────────────────────
     The id was random, so submitting the same supplier invoice twice created two
     payable documents for one debt — and each was independently payable. A supplier's
     invoice number is unique per supplier by definition, so the id is derived from
     (poId, supplierId, invoiceNumber). A resubmission addresses the same document. */
  const invoiceId = _deterministicId(
    poId + '|' + String(po.supplierId) + '|' + _san(String(invoiceNumber), 100), 'inv');

  const invData = {
    invoiceId,
    poId,
    grnId:          verifiedGrnId,
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

  /* create(), not set(): a second submission of the same supplier invoice must be
     REJECTED rather than silently overwriting a document that may already be paid. */
  const invRefNew = db.collection('procSupplierInvoices').doc(invoiceId);
  try {
    await invRefNew.create(invData);
  } catch (e) {
    if (e && (e.code === 6 || e.code === 'already-exists' || /already exists/i.test(e.message || ''))) {
      _err('An invoice with this number already exists for this purchase order.', 'already-exists');
    }
    throw e;
  }

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
  const invPre = invSnap.data() || {};

  /* MERCHANT SCOPING (Slice E), composed with the existing admin requirement rather than
     replacing it. _requireAdmin proves a platform role, never that it is held FOR THIS
     MERCHANT — the same gap Slice C closed on approval, and it matters more here because
     this moves money. The merchant is read off the invoice. */
  await _assertMerchantAuthority(request, invPre.merchantId);

  /* ── ONE ATOMIC, IDEMPOTENT PAYMENT ─────────────────────────────────────────────
     The paid-check was a read OUTSIDE the write batch. Two concurrent payment attempts
     both observed paidAt === null, both proceeded, and both committed: the supplier
     balance was decremented twice and four ledger rows were written for one debt. The
     check now lives inside the transaction that performs the writes, so the loser's read
     is invalidated and it retries into the already-paid branch.

     Ledger ids are derived from the invoice too, so even a retry that somehow reached the
     write stage would address the same two rows rather than appending new ones. */
  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(invRef);
    if (!snap.exists) _err('Invoice not found.', 'not-found');
    const inv = snap.data() || {};

    /* Already paid: report the ORIGINAL outcome. A retry of a completed payment is not a
       new payment, and must not be reported as a failure that invites another attempt. */
    if (inv.paidAt) {
      return { invoiceId, status: 'paid', total: inv.total, duplicate: true };
    }
    if (inv.status === 'disputed') {
      _err('Cannot pay a disputed invoice. Resolve the dispute first.');
    }
    if (!['pending', 'approved'].includes(inv.status)) {
      _err("Cannot pay invoice in status '" + inv.status + "'.");
    }

    /* The supplier must exist. Unlike a stock document, a missing supplier is not
       something to create on the fly — paying a counterparty the system has no record of
       is exactly the state this slice exists to prevent. */
    const supplierRef  = db.collection('procSuppliers').doc(String(inv.supplierId));
    const supplierSnap = await t.get(supplierRef);
    if (!supplierSnap.exists) _err('Supplier not found for this invoice.', 'failed-precondition');

    const now = F.serverTimestamp();
    const method = _san(paymentMethod, 50);
    const ref    = paymentRef ? _san(paymentRef, 200) : null;

    t.update(invRef, {
      status:        'paid',
      paidAt:        now,
      paidBy:        uid,
      paymentMethod: method,
      paymentRef:    ref,
      updatedAt:     now,
    });

    t.update(supplierRef, {
      currentBalance: F.increment(-inv.total),
      updatedAt:      now,
    });

    /* Double-entry, unchanged in meaning:
         DEBIT  accounts_payable  (liability decreases)
         CREDIT bank/cash/mpesa   (asset decreases) */
    const common = {
      amount:      inv.total,
      currency:    'KES',
      refType:     'supplier_invoice',
      refId:       invoiceId,
      supplierId:  inv.supplierId,
      merchantId:  inv.merchantId,
      poId:        inv.poId,
      description: 'Supplier invoice payment - ' + inv.invoiceNumber,
      performedBy: uid,
      createdAt:   now,
    };
    t.set(db.collection('paymentLedger').doc(_deterministicId(invoiceId + '|debit', 'led')),
      Object.assign({ type: 'debit', account: 'accounts_payable' }, common));
    t.set(db.collection('paymentLedger').doc(_deterministicId(invoiceId + '|credit', 'led')),
      Object.assign({ type: 'credit', account: method, paymentRef: ref }, common));

    if (inv.poId) {
      t.update(db.collection('procPurchaseOrders').doc(inv.poId), {
        status:    'paid',
        updatedAt: now,
      });
    }

    return { invoiceId, status: 'paid', total: inv.total, duplicate: false };
  });

  if (!result.duplicate) {
    await _audit(uid, 'supplier_invoice_paid', invoiceId, {
      merchantId: invPre.merchantId, supplierId: invPre.supplierId,
      total: result.total, paymentMethod,
    });
  }

  logger.info('procurement.approveAndPayInvoice', {
    invoiceId, total: result.total, paymentMethod, duplicate: result.duplicate,
  });
  return result;
});

/* ════════════════════════════════════════════════════════════════
   8. getSupplierPerformance
   Return monthly performance trend for a supplier.
════════════════════════════════════════════════════════════════ */
const getSupplierPerformance = onCall(OPT, async (request) => {
  _requireAuth(request);
  const { supplierId, merchantId: _requestedMerchantId, months } = request.data ?? {};

  if (!supplierId) _err('supplierId is required.');
  /* Reads are tenant data too — the caller must be authorized for the merchant whose
     supplier performance they are asking about. */
  const merchantId = await _assertMerchantAuthority(request, _requestedMerchantId);

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

   A SEPARATE, deeper gap than the posProducts field-mismatch this function's
   body was fixed for (docs/POSPRODUCTS_MIGRATION_GRAPH.md): `procForecast` —
   the collection this function reads FIRST, below — has no writer anywhere in
   this codebase. Nothing computes or populates a forecast row, ever, so
   `forecastSnap` is always empty and this function always returns an empty
   `reorderList`, regardless of the posProducts lookup fix. That fix is still
   correct and worth having (it removes a real, independent defect, and holds
   if a forecast-generation writer is ever built), but does not make this
   feature functional end to end. Not fixed here — building a forecast
   generator is a materially larger undertaking than a field-name correction.
════════════════════════════════════════════════════════════════ */
const getProcurementForecast = onCall(OPT, async (request) => {
  _requireAuth(request);
  /* Same authority fix as the dashboard: forecast reads a merchant's consumption history. */
  await _assertMerchantAuthority(request, (request.data || {}).merchantId);
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

  /* Fetch posProducts in batches (Firestore limit: 30 per 'in' query).
     posUpsertProduct's real document ID is the plain productId (or `p_<idemKey>`
     on create) — never a `${branchId}_${productId}` composite, and the document
     itself never carries a `productId` FIELD (only merchantId/branchId/name/...).
     The previous composite-ID lookup, keyed by a field that doesn't exist on any
     real document, could never match anything. See
     docs/POSPRODUCTS_MIGRATION_GRAPH.md. */
  const BATCH_SIZE  = 30;
  const productDocs = {};
  for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
    const batchIds   = productIds.slice(i, i + BATCH_SIZE);
    const batchSnaps = await db.collection('posProducts')
      .where(admin.firestore.FieldPath.documentId(), 'in', batchIds)
      .get();
    batchSnaps.forEach(s => { productDocs[s.id] = s.data(); });
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
  const { merchantId: _requestedMerchantId } = request.data ?? {};

  /* AUTHORITY FIX (Slice I), not a read helper. This required only _requireAuth while
     accepting merchantId from the payload, so any signed-in user could read any merchant's
     open POs, pending approvals, goods-to-receive and payables — including overdue invoice
     detail. The queried value is now the authorized one. */
  const merchantId = await _assertMerchantAuthority(request, _requestedMerchantId);

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
  resolveMerchantContext,
  listSuppliers,
  listPurchaseOrders,
  listGRNs,
  listSupplierInvoices,
  listWarehouseStock,
  listStockMovements,
  addSupplier,
  updateSupplier,
  setSupplyParticipation,
  findSuppliers,
  getSupplyCatalogue,
  getInboundSupplyOrders,
  createPurchaseOrder,
  getPurchaseOrder,
  approvePurchaseOrder,
  sendPurchaseOrder,
  receiveGoods,
  createSupplierInvoice,
  approveAndPayInvoice,
  getSupplierPerformance,
  getProcurementForecast,
  getProcurementDashboard,
  scheduledVendorPerformanceUpdate,
  _SUPPLIER_MUTABLE: SUPPLIER_MUTABLE,
  _assertMerchantAuthority,
  _assertSupplierSideAuthority,
  _assertPoAuthority,
  _merchantIdForm,
  _listScoped,
  _assertSuppliesEnabled,
  _SUPPLY_MUTABLE: SUPPLY_MUTABLE,
  _DISCOVERABLE_FIELDS: DISCOVERABLE_FIELDS,
  _DISCOVERABLE_SUPPLY_FIELDS: DISCOVERABLE_SUPPLY_FIELDS,
  _projectDiscoverable,
  _assertActiveBusinessAudience,
  _CATALOGUE_FIELDS: CATALOGUE_FIELDS,
  _CATALOGUE_SCAN: CATALOGUE_SCAN,
  _isCatalogueEntry,
  _availability,
  _positiveNumber,
  _projectCatalogueEntry,
};
