/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT IDENTITY AUTHORITY
   ══════════════════════════════════════════════════════════════════════════════
   ONE trustworthy answer to three questions, so no UI ever has to invent one:

       who is the merchant / shop?
       who is serving this sale?
       what role does that person have?

   and, built on top of those and kept internally separate:

       EMPLOYEE SALE AUTHORITY — may THIS authenticated person transact on
       behalf of THIS shop, and under whose name does the receipt go out?

   ── WHAT IS NEVER TRUSTED ───────────────────────────────────────────────────
   `servedBy`, `role`, `employeeUid` and `cashierName` are NOT accepted from the
   client under any circumstances. `shopId` may be REQUESTED as context — the
   caller has to say which shop it means — but the server then resolves the actual
   relationship from `shops/{uid}` and `shopEmployees/{uid}` and refuses if there
   isn't one. A request is a question, never an assertion.

   ── FAIL CLOSED, ALWAYS ─────────────────────────────────────────────────────
   If the acting identity cannot be established, the sale is REFUSED. It must never
   fall through to the shop owner and must never produce an anonymous receipt. A
   receipt crediting the owner for an employee's sale is a false financial record,
   and it is exactly the record a shift dispute turns on — so "we couldn't tell who
   it was, put the owner" is the one outcome this file exists to make impossible.

   ── WHY SHOPS, NOT MERCHANTS ────────────────────────────────────────────────
   `shops/{uid}` is the canonical storefront document (firestore.rules.live:1404):
   name, storeName, logo, logoUrl, phone, email, address, city — publicly readable,
   owner-writable, admin-created. It is the ONE source the receipt renderer already
   expects. `merchants/{id}` has no rules block at all and is server-side only.

   NOTE ON KRA PIN: `shops/{uid}` has no tax field, so the identity payload carries
   none. It is read from a tax profile where one exists and omitted otherwise —
   never invented, never stored as a receipt-only copy.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const OPTS = { region: REGION, enforceAppCheck: true };

function _db() { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

const _s = (v, n) => (typeof v === 'string' ? v.replace(/[<>"'&]/g, '').slice(0, n || 120).trim() : '');

function _uid(auth) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  return auth.uid;
}

/* An employment record only counts when the shop has actually approved it. A
   pending or revoked relationship is NOT a relationship — and `shopEmployees` is
   self-declarable (any user may create a record naming themselves the owner), so a
   record alone proves nothing without the shopOwnerId match below. */
const ACTIVE_EMPLOYMENT = ['active', 'approved', 'enabled'];
/* Absent status is treated as active only for records that predate the field; a
   record explicitly marked otherwise is refused. */
function _employmentActive(rec) {
  const st = _s(rec.status, 24).toLowerCase();
  if (!st) return true;
  return ACTIVE_EMPLOYMENT.indexOf(st) > -1;
}

/* Employment roles, mapped to the receipt's vocabulary. An unknown role is NOT
   silently promoted to 'staff' — it is refused, because a receipt should not name
   a role nobody defined. */
const EMPLOYEE_ROLES = {
  cashier: { role: 'cashier', label: 'Staff' },
  staff: { role: 'staff', label: 'Staff' },
  manager: { role: 'manager', label: 'Manager' },
  supervisor: { role: 'manager', label: 'Manager' },
};

/* Operations an employment role may perform. Deliberately explicit: a new role
   grants nothing until it is listed here. */
const ROLE_CAPABILITIES = {
  owner: ['sell', 'refund', 'discount', 'openShift', 'closeShift', 'manageStaff'],
  manager: ['sell', 'refund', 'discount', 'openShift', 'closeShift'],
  cashier: ['sell', 'openShift'],
  staff: ['sell'],
};

/* ══════════════════════════════════════════════════════════════════════════════
   THE AUTHORITY — every caller in this file goes through here
   ══════════════════════════════════════════════════════════════════════════════
   Returns { ok:true, shopId, shop, servedBy } or { ok:false, reason }.
   Never throws for an ordinary refusal; the caller decides how to surface it. */
async function resolveActor(uid, requestedShopId) {
  if (!uid) return { ok: false, reason: 'unauthenticated' };
  const shopId = _s(requestedShopId, 64);
  if (!shopId) return { ok: false, reason: 'shop-not-specified' };

  const shopSnap = await _db().collection('shops').doc(shopId).get();
  if (!shopSnap.exists) return { ok: false, reason: 'shop-not-found' };
  const shop = shopSnap.data() || {};

  /* ── THE OWNER ───────────────────────────────────────────────────────────
     shops/{uid} is keyed BY the owner's uid, so ownership is the document id
     itself — there is no ownerId field to forge. */
  if (uid === shopId) {
    const person = await _personName(uid);
    if (!person) return { ok: false, reason: 'owner-name-unresolved' };
    return {
      ok: true, shopId: shopId, shop: shop,
      servedBy: { uid: uid, name: person, role: 'owner', label: 'Owner' },
      capabilities: ROLE_CAPABILITIES.owner.slice(),
      source: 'shop-owner',
    };
  }

  /* ── THE EMPLOYEE ────────────────────────────────────────────────────────
     shopEmployees/{empUid}.shopOwnerId must equal the shop being acted on. A
     self-declared record (shopOwnerId == the employee) therefore matches only
     their OWN shop and grants nothing over anyone else's. */
  const empSnap = await _db().collection('shopEmployees').doc(uid).get();
  if (!empSnap.exists) return { ok: false, reason: 'not-employed-here' };
  const emp = empSnap.data() || {};
  if (_s(emp.shopOwnerId, 64) !== shopId) return { ok: false, reason: 'not-employed-here' };
  if (!_employmentActive(emp)) return { ok: false, reason: 'employment-inactive' };

  const mapped = EMPLOYEE_ROLES[_s(emp.role, 24).toLowerCase()];
  if (!mapped) return { ok: false, reason: 'employment-role-unknown' };

  /* The employee's OWN name. It comes from the employment record or their user
     document — never from the shop, because that is the owner's name and using it
     is the exact false attribution this file prevents. */
  const name = _s(emp.name, 60) || await _personName(uid);
  if (!name) return { ok: false, reason: 'employee-name-unresolved' };

  return {
    ok: true, shopId: shopId, shop: shop,
    servedBy: { uid: uid, name: name, role: mapped.role, label: mapped.label },
    capabilities: (ROLE_CAPABILITIES[mapped.role] || []).slice(),
    source: 'shop-employee',
  };
}

/* The person's own name, from their own record. Returns '' when it cannot be
   established — the caller then FAILS rather than substituting anyone. */
async function _personName(uid) {
  try {
    const u = await _db().collection('users').doc(uid).get();
    if (u.exists) {
      const d = u.data() || {};
      const n = _s(d.name, 60) || _s(d.displayName, 60) || _s(d.fullName, 60);
      if (n) return n;
    }
  } catch (_) { /* fall through to auth */ }
  try {
    const rec = await admin.auth().getUser(uid);
    return _s(rec.displayName, 60);
  } catch (_) { return ''; }
}

/* The shop identity the receipt renderer consumes. Only fields that exist — an
   absent logo is absent, not an empty string, so the renderer's wordmark fallback
   engages instead of drawing an empty frame. */
function shopIdentity(shopId, shop) {
  const out = { shopId: shopId };
  const put = (k, v) => { const s = _s(v, 200); if (s) out[k] = s; };
  put('name', shop.name || shop.storeName);
  put('logo', shop.logo || shop.logoUrl);
  put('phone', shop.phone);
  put('email', shop.email);
  put('address', shop.address);
  put('city', shop.city || shop.town);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════
   merchantIdentity — who is the shop, and who am I within it
   ══════════════════════════════════════════════════════════════════════════════ */
exports.merchantIdentity = onCall(OPTS, async ({ data, auth }) => {
  const uid = _uid(auth);
  const r = await resolveActor(uid, (data || {}).shopId);
  if (!r.ok) throw new HttpsError('permission-denied', 'identity-unresolved:' + r.reason);
  return {
    shop: shopIdentity(r.shopId, r.shop),
    servedBy: r.servedBy,
    capabilities: r.capabilities,
    source: r.source,
  };
});

/* ══════════════════════════════════════════════════════════════════════════════
   EMPLOYEE SALE AUTHORITY — employeeSaleAuthorize
   ══════════════════════════════════════════════════════════════════════════════
   Binds a sale's idempotency key to a SERVER-RESOLVED identity, before the sale
   runs. The attribution document is created atomically with create(), so a key can
   be attributed exactly once and a second caller cannot re-attribute someone
   else's sale to themselves.

   The client passes the same idempotencyKey to posCompleteCheckout, so the sale
   and its attribution are bound by that key. What this call CANNOT do on its own
   is stop a caller from skipping it — enforcement inside posCompleteCheckout is a
   one-line guard on a deployed money path and is deliberately a separate, reviewed
   change. See docs/MERCHANT_IDENTITY_AUTHORITY.md.
════════════════════════════════════════════════════════════════════════════════ */
exports.employeeSaleAuthorize = onCall(OPTS, async ({ data, auth }) => {
  const uid = _uid(auth);
  const d = data || {};
  const idempotencyKey = _s(d.idempotencyKey, 128);
  if (!idempotencyKey) throw new HttpsError('invalid-argument', 'idempotencyKey required');

  /* shopId is CONTEXT — the caller says which shop it means, and the server then
     proves the relationship or refuses. */
  const r = await resolveActor(uid, d.shopId);
  if (!r.ok) throw new HttpsError('permission-denied', 'sale-not-authorized:' + r.reason);
  if (r.capabilities.indexOf('sell') === -1) {
    throw new HttpsError('permission-denied', 'sale-not-authorized:role-cannot-sell');
  }

  const ref = _db().collection('posSaleAttribution').doc(idempotencyKey);
  const attribution = {
    idempotencyKey: idempotencyKey,
    shopId: r.shopId,
    /* Straight from the authority. Nothing here came off the wire. */
    servedByUid: r.servedBy.uid,
    servedByName: r.servedBy.name,
    servedByRole: r.servedBy.role,
    servedByLabel: r.servedBy.label,
    source: r.source,
    createdAt: _now(),
  };

  try {
    await ref.create(attribution);
  } catch (e) {
    /* Already attributed. Returning the ORIGINAL is correct for a retry of the same
       sale; a DIFFERENT person claiming the same key is refused. */
    const prev = await ref.get();
    if (!prev.exists) throw new HttpsError('internal', 'attribution-failed');
    const p = prev.data() || {};
    if (p.servedByUid !== uid || p.shopId !== r.shopId) {
      throw new HttpsError('permission-denied', 'sale-not-authorized:key-belongs-to-another');
    }
    return { shopId: p.shopId, servedBy: {
      uid: p.servedByUid, name: p.servedByName, role: p.servedByRole, label: p.servedByLabel },
      shop: shopIdentity(r.shopId, r.shop), replayed: true };
  }

  return {
    shopId: r.shopId,
    servedBy: r.servedBy,
    shop: shopIdentity(r.shopId, r.shop),
    replayed: false,
  };
});

/* Internals exported for the certification suite. Not part of the callable API. */
exports._internal = {
  resolveActor, shopIdentity, ROLE_CAPABILITIES, EMPLOYEE_ROLES,
  ACTIVE_EMPLOYMENT, _employmentActive,
};
