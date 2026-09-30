'use strict';

/**
 * pos-supplier-sync.js
 * SOKONI SmartPOS — authoritative server-side persistence for the supplier/procurement
 * surface driven by `pos-suppliers.js`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `pos-suppliers.js` is local-first (IndexedDB) and mirrored every write to Firestore
 * directly from the browser via a fire-and-forget `_sync()` whose failure was swallowed by
 * `.catch(() => {})`. Every one of those writes was denied by the served ruleset: the whole
 * SmartPOS block (`posPurchaseOrders`, `posSuppliers`, `posWarehouses`, ...) grants `read`
 * only, and `posGRN` / `posSupplierInvoices` / `posSupplierPayments` have no match block at
 * all — a closed-world deny. The UI therefore believed it was syncing and never was, and
 * not one document ever landed in either Firestore database.
 *
 * The architecture those rules encode is server-authoritative writes: the browser reads,
 * Cloud Functions write with Admin SDK authority. This module is that write path. The rules
 * are deliberately NOT widened.
 *
 * AUTHORITY MODEL — read this before changing anything here
 * ---------------------------------------------------------
 * `users/{uid}.merchantId`, `.sellerId`, `.businessId` and `.shopId` are ALL self-writable
 * by the user they describe (proven against the served ruleset). No identity field on a
 * `users` document is ever an authorization input here — a check against a caller-controlled
 * value is worse than no check, because it stops anyone looking closer.
 *
 * The canonical authority is `businesses/{merchantId}.ownerId`, reached through
 * `workforce-identity._assertBusinessPermission`, which grants the owner everything and
 * otherwise requires an active `workspaceMemberships` record carrying the named capability.
 * The owner-uid form (`merchantId === auth.uid`) is honoured without a lookup because
 * merchants operating under their own uid are real and in production.
 *
 * `sellerId` is NEVER accepted from the payload — the sibling writer in pos-inventory-pro.js
 * does accept it, gated only by the forgeable `posRole` claim, and that is precisely the
 * defect shape this module refuses to reproduce. It is derived server-side from the resolved
 * owner and stamped onto every document, which is also what makes the served read rule
 * (`resource.data.sellerId == request.auth.uid`) return the data to the merchant afterwards.
 */

const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const { _assertBusinessPermission } = require('./workforce-identity');

exports._h = {}; // handler registry — consumed by smartpos-dispatch.js
const db = admin.firestore();

const _TS = () => admin.firestore.FieldValue.serverTimestamp();

/* The capability required to write the procurement surface. Deliberately an EXISTING
   permission from the workspaceMemberships vocabulary (discounts|pos|refunds|users) —
   inventing a new string would deny every current member, since no membership carries it. */
const REQUIRED_PERMISSION = 'pos';

/* ═══════════════════════════════════════════════════════════════
   ENTITY REGISTRY — the only collections this op may ever write.
   A closed allow-list: an unknown entity is rejected, never routed.
═══════════════════════════════════════════════════════════════ */
const ENTITIES = {
  supplier:        { collection: 'posSuppliers',        required: ['name'] },
  /* purchaseOrder REMOVED (Slice B, 2026-09-05). Purchase orders are owned by the
     canonical procurement engine — procPurchaseOrders, via createPurchaseOrder. No
     browser-side pos* PO cloud writer may survive; re-adding an entry here would
     recreate the second PO engine the convergence exists to eliminate. */
  grn:             { collection: 'posGRN',              required: ['supplierId'] },
  supplierInvoice: { collection: 'posSupplierInvoices', required: ['supplierId'] },
  supplierPayment: { collection: 'posSupplierPayments', required: ['supplierId'] },
};

/* Fields the server owns outright. A client-supplied value for any of these is discarded,
   not merged — otherwise the caller could point a document at another merchant. */
const SERVER_OWNED = ['sellerId', 'merchantId', 'createdBy', 'syncedAt', 'serverUpdatedAt'];

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

function _requireAuth(req) {
  const uid = req && req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to sync supplier data.');
  return req.auth;
}

function _requireString(v, name, max = 300) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new HttpsError('invalid-argument', name + ' is required and must be a non-empty string.');
  }
  if (v.length > max) {
    throw new HttpsError('invalid-argument', name + ' exceeds ' + max + ' characters.');
  }
  return v.trim();
}

/**
 * Resolve the merchant's canonical owner uid and assert the caller may write for it.
 *
 * Returns the OWNER's uid — not the caller's. That value is stamped as `sellerId` so the
 * served read rule returns the document to the merchant. An employee writing on the
 * merchant's behalf therefore creates a document they cannot themselves read back; that is
 * the existing rules design for this collection block, not something this module decides.
 *
 * @returns {Promise<string>} the owner uid to stamp as sellerId
 */
async function _assertMerchantWriteAuthority(auth, merchantId, dbOverride) {
  const uid = auth.uid;
  /* The authority read is INJECTABLE, for tests only — production callers pass nothing and
     get the module handle, so the deployed path is byte-for-byte what it was.
     Why it exists: `db` is `admin.firestore()` captured at module load, so a suite that
     merely requires this file and calls the helper performs a LIVE read against whatever
     project the ambient app resolves to. The sabotage control for the missing-business
     branch was doing exactly that — it "caught" the defect only because a network call
     happened to fail with wording that matched its expectation, and it flipped to a false
     FAIL the moment the harness pinned a different GCLOUD_PROJECT. An authority test must
     decide from an injected document, not from whether a socket was reachable. */
  const _db = dbOverride || db;

  /* Platform admins: unforgeable custom claims only. */
  const isAdmin = !!(auth.token && (auth.token.admin === true || auth.token.superAdmin === true));

  /* Owner-uid form — the merchant operating directly under their own uid. No lookup, and
     no way to spoof it: it is the authenticated uid compared against itself. */
  if (merchantId === uid) return uid;

  const bizSnap = await _db.collection('businesses').doc(merchantId).get();
  if (!bizSnap.exists) {
    /* Deny on a missing authority document. Absence is not permission. */
    throw new HttpsError('not-found', 'Business not found.');
  }
  const ownerId = (bizSnap.data() || {}).ownerId;
  if (!ownerId || typeof ownerId !== 'string') {
    throw new HttpsError('failed-precondition', 'Business has no owner and cannot be written to.');
  }

  if (ownerId === uid) return ownerId;
  if (isAdmin) return ownerId;

  /* Employee path: an active membership carrying the capability. Membership alone is not
     authority — _assertBusinessPermission throws unless the permission is explicitly held. */
  await _assertBusinessPermission(uid, merchantId, REQUIRED_PERMISSION);
  return ownerId;
}

/* ═══════════════════════════════════════════════════════════════
   OP: posSupplierSync
═══════════════════════════════════════════════════════════════ */

/**
 * Mirror one locally-created supplier/procurement record to its authoritative collection.
 *
 * Request: { op:'posSupplierSync', merchantId, entity, id, data }
 * Success: { ok:true, entity, collection, id, sellerId }
 * Failure: throws HttpsError — the client MUST surface it. This op never resolves to a
 *          success-shaped value on a failed write; a swallowed error is the defect it fixes.
 */
exports._h.posSupplierSync = async (req) => {
  const auth = _requireAuth(req);
  const body = req.data || {};

  const merchantId = _requireString(body.merchantId, 'merchantId', 200);
  const entity     = _requireString(body.entity, 'entity', 40);
  const id         = _requireString(body.id, 'id', 200);

  const spec = Object.prototype.hasOwnProperty.call(ENTITIES, entity) ? ENTITIES[entity] : null;
  if (!spec) {
    throw new HttpsError(
      'invalid-argument',
      'Unknown entity "' + entity + '". Valid entities: ' + Object.keys(ENTITIES).sort().join(', ')
    );
  }

  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new HttpsError('invalid-argument', 'data must be an object.');
  }

  /* Per-entity required fields, validated server-side rather than trusted from the client. */
  for (const field of spec.required) {
    _requireString(body.data[field], 'data.' + field);
  }

  /* Authority BEFORE any write, and the owner uid it returns is the identity we stamp. */
  const sellerId = await _assertMerchantWriteAuthority(auth, merchantId);

  /* Strip every server-owned field from the client payload, then re-stamp them ourselves. */
  const clean = {};
  for (const k of Object.keys(body.data)) {
    if (SERVER_OWNED.indexOf(k) === -1) clean[k] = body.data[k];
  }

  const doc = Object.assign(clean, {
    sellerId: sellerId,
    merchantId: merchantId,
    id: id,
    createdBy: auth.uid,
    syncedAt: _TS(),
    serverUpdatedAt: _TS(),
  });

  await db.collection(spec.collection).doc(id).set(doc, { merge: true });

  return { ok: true, entity: entity, collection: spec.collection, id: id, sellerId: sellerId };
};

/* Exported for the certification suite — not part of the callable surface. */
exports._ENTITIES = ENTITIES;
exports._SERVER_OWNED = SERVER_OWNED;
exports._REQUIRED_PERMISSION = REQUIRED_PERMISSION;
exports._assertMerchantWriteAuthority = _assertMerchantWriteAuthority;
