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
/* THE employee predicate, from the module that owns the contract — never a
   local copy. See the employee arm of resolveActor. */
const { employeeRecordReasons } = require('./shop-employees');

const REGION = 'us-central1';
const OPTS = { region: REGION, enforceAppCheck: true };

function _db() { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

const _s = (v, n) => (typeof v === 'string' ? v.replace(/[<>"'&]/g, '').slice(0, n || 120).trim() : '');

function _uid(auth) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  return auth.uid;
}


/* Employment roles, mapped to the receipt's vocabulary. An unknown role is NOT
   silently promoted to 'staff' — it is refused, because a receipt should not name
   a role nobody defined. */
/* ── THE CANONICAL EMPLOYEE ROLES — ratified 2026-09-06 ────────────────────────
   `cashier | manager | inventory | support`, and no others. This file previously
   declared `staff` and `supervisor`, which shop-employees.js's SHOP_ROLES does not
   contain — and SHOP_ROLES is what the invite writer ENFORCES
   (`if (!SHOP_ROLES.includes(role)) throw "Invalid role"`). So `staff` and
   `supervisor` could never be invited and existed only here, while `inventory` and
   `support` could be invited and resolved to nothing at all: two of the four
   invitable roles could not sell, and two of the roles this file understood could
   not exist. The mismatch survived because production `shopEmployees` is empty —
   no record ever exercised the seam.

   This map is now a DISPLAY LABEL over the canonical list, not a second gate. The
   gate is SHOP_ROLES, in one place. */
const EMPLOYEE_ROLES = {
  cashier: { role: 'cashier', label: 'Cashier' },
  manager: { role: 'manager', label: 'Manager' },
  inventory: { role: 'inventory', label: 'Stock' },
  support: { role: 'support', label: 'Support' },
};

/* ── THE CAPABILITY VOCABULARY ────────────────────────────────────────────────
   Declared in FULL, once, before any surface enforces it — so Step 1B is pure
   enforcement against a settled vocabulary rather than verbs invented per page.
   Every backend operation that an employee can reach names one of these. */
const CAPABILITIES = Object.freeze([
  'sell', 'collectPayment', 'printReceipt', 'viewReceipts',
  'discount', 'refund',
  'openShift', 'closeShift',
  'manageInventory', 'manageProducts', 'supply',
  'viewOrders', 'manageOrders',
  'viewAnalytics', 'viewFinancials',
  'manageStaff', 'manageStore', 'manageAvailability', 'manageCalendar',
  'manageNotifications',
]);

/* THE OWNER IS NOT AN EMPLOYEE ROLE. The business owner's authority comes from
   owning the shop — `shops/{uid}`, the document id — not from an employment
   record, so it is declared separately and is deliberately not a key of
   ROLE_CAPABILITIES. An owner cannot be invited, restricted or revoked. */
const OWNER_CAPABILITIES = Object.freeze(CAPABILITIES.slice());

/* The CEILING each employment role may reach. Deliberately explicit: a new role
   grants nothing until it is listed here, and nothing may exceed CAPABILITIES. */
const ROLE_CAPABILITIES = {
  manager:   ['sell', 'collectPayment', 'printReceipt', 'viewReceipts', 'discount', 'refund',
              'openShift', 'closeShift', 'manageInventory', 'manageProducts', 'supply',
              'viewOrders', 'manageOrders', 'viewAnalytics', 'viewFinancials',
              'manageNotifications',
              /* 2026-09-29 (owner brief: 'Manager: manage availability if permission granted'): within the
                 ceiling, so granted by default and WITHDRAWN per manager through emp.restrictions. Enforced by
                 kasshop.setShopAvailability — the first enforcer of this declared capability. */
              'manageAvailability'],
  cashier:   ['sell', 'collectPayment', 'printReceipt', 'viewReceipts', 'openShift', 'closeShift'],
  inventory: ['manageInventory', 'manageProducts', 'supply', 'viewOrders'],
  support:   ['viewOrders', 'manageOrders', 'viewReceipts', 'manageNotifications'],
};

/* ── OWNER RESTRICTIONS — a NARROWING overlay, never a grant ───────────────────
       effective = roleCeiling ∩ (allowed by the owner)
   and never `roleCeiling ∪ ownerGrants`. The distinction is the whole point: an
   owner may say a cashier must not discount, but no entry in the permission editor
   can make a cashier a manager. A restriction naming a capability the role never
   had is a no-op, not an escalation.

   `emp.restrictions` is an array of capability names the owner has WITHDRAWN. It is
   read from the employment document, which only the owner (or a platform admin) can
   write — see assertShopOwner in shop-employees.js. */
function effectiveCapabilities(roleCeiling, restrictions) {
  const ceiling = Array.isArray(roleCeiling) ? roleCeiling : [];
  const denied = Array.isArray(restrictions)
    ? restrictions.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  /* INTERSECTION, expressed as the ceiling minus withdrawals. Anything the owner
     names that is not in the ceiling simply never appears — it cannot add. */
  return ceiling.filter((c) => denied.indexOf(c) === -1);
}

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
      /* The owner is NOT an employee role — their authority comes from owning the
           shop, so it is never narrowed by a restrictions field they would have to
           write against themselves. */
        capabilities: OWNER_CAPABILITIES.slice(),
      source: 'shop-owner',
    };
  }

  /* ── THE EMPLOYEE ────────────────────────────────────────────────────────
     shopEmployees/{empUid}.shopOwnerId must equal the shop being acted on. A
     self-declared record (shopOwnerId == the employee) therefore matches only
     their OWN shop and grants nothing over anyone else's. */
  /* THE CANONICAL KEY — `{shopId}_{uid}`, ratified 2026-09-06. This read used
     `shopEmployees/{uid}`, which shop-employees.js exports as `legacyEmployeeDocId`
     and explicitly "refuses to honour", while the invite writer has always created
     `{shopId}_{uid}`. An accepted invite was therefore invisible to the one reader
     that gates POS sales and servedBy — which is why shop-employees.js's header
     says employee access "has never worked in production".

     NO FALLBACK to the legacy id. A reader accepting both would recreate the split
     authority the consolidation removed. Production carries ZERO shopEmployees and
     ZERO shopInvites (census 2026-09-06, with users/shops/applications as controls),
     so this cut-off revokes nobody. */
  const empSnap = await _db().collection('shopEmployees').doc(`${shopId}_${uid}`).get();
  if (!empSnap.exists) return { ok: false, reason: 'not-employed-here' };
  const emp = empSnap.data() || {};

  /* CORROBORATION against the shop document, not the record's own say-so.
     firestore.rules lets any signed-in client create a shopEmployees document whose
     shopOwnerId is THEMSELVES, so a record proves nothing on its own. The shop
     document names the real owner; a forgery will not agree with it.

     Under the ratified `shops/{uid}` contract the document id IS the owner, so
     `shopId` and `shopData.ownerId` must agree — asserted rather than assumed,
     because the two ownership representations diverging is precisely how a
     corroboration check stops corroborating anything. */
  const shopOwner = _s(shop.ownerId || shop.sellerUid || shop.ownerUid, 64);
  if (shopOwner && shopOwner !== shopId) return { ok: false, reason: 'shop-ownership-inconsistent' };

  /* ── THE EMPLOYEE PREDICATE IS NOT OURS TO OWN ───────────────────────────
     shop-employees.js is "the ONE contract for who works at this shop" and
     states the predicate in its own header: believed iff shopId matches, uid
     matches, ACTIVE !== FALSE, role is a known shop role, and shopOwnerId
     matches the shop's real owner. This function previously reimplemented four
     of those five and replaced the fifth with a private `status` vocabulary
     that NO WRITER HAS EVER WRITTEN — `_employmentActive` returned true for an
     absent field, so `removeShopEmployee` revoked nothing here while returning
     success to the owner, and a removed cashier kept selling.

     Adjudicated in docs/SHOP_EMPLOYMENT_TILL_AUTHORITY_DECISION.md. The repair
     is to CONSUME the authority, not to teach the private copy a second field
     name — the duplication itself was the defect.

     WE STILL DECIDE OWNERSHIP. `shopId` is passed as the owner uid because in
     THIS function ownership is the shops/{uid} document id, which cannot be
     forged by writing a field. shop-employees.js resolves owners from the
     ownerId|sellerUid|ownerUid union instead. Converging those two owner models
     is separate work and is deliberately NOT done here. */
  const reasons = employeeRecordReasons(emp, shopId, uid, shopId);
  if (reasons.length) {
    /* The caller's existing refusal vocabulary is preserved exactly; changing
       what a refusal discloses is a behaviour change this repair does not make. */
    return { ok: false,
             reason: reasons.indexOf('inactive') > -1 ? 'employment-inactive'
                   : reasons.indexOf('unknown role') > -1 ? 'employment-role-unknown'
                   : 'not-employed-here' };
  }

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
    /* The role's CEILING, narrowed by whatever the owner has withdrawn. Never
       widened: a restriction naming a capability this role never had is a no-op. */
    capabilities: effectiveCapabilities(ROLE_CAPABILITIES[mapped.role], emp.restrictions),
    restrictions: Array.isArray(emp.restrictions) ? emp.restrictions.slice() : [],
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

/* ══════════════════════════════════════════════════════════════════════════════
   THE MERCHANT ACCOUNT LINK — one business, more than one login
   ══════════════════════════════════════════════════════════════════════════════
   KASS is two accounts. A KES 499 `starter` subscription is ACTIVE on
   `xrH21J5GF…`, which has no shop; the shop `D5Ql2…` has no paid subscription.
   Entitlement resolves per-uid, so the shop resolves FREE — correctly, given the
   data it can see. Nothing in the entitlement engine is misbehaving.

   The repair is an EXPLICIT, AUDITABLE relationship, not a special case scattered
   through subscription resolution and not a heuristic.

   ── SAME NAME IS NOT SAME MERCHANT ──────────────────────────────────────────
   There is deliberately no matching on name, phone or email. Two accounts called
   KASS may be one business or two, and guessing wrong merges a stranger's paid
   plan into someone else's shop. A link exists only because an ADMIN created it,
   with a reason and evidence recorded.

   ── A LINK CANNOT BE SELF-DECLARED ──────────────────────────────────────────
   `merchantAccountLinks` is server-owned: unlisted in firestore.rules means the
   default DENY applies, and the proposed explicit rule (docs/) keeps client
   writes at `if false`. The callable additionally requires an admin claim. Either
   layer alone would stop a customer linking themselves to a paid account; both
   are present because this one grants money-backed entitlement.

   ── AMBIGUITY IS REFUSED ────────────────────────────────────────────────────
   A uid may belong to AT MOST ONE canonical identity. A second claim on the same
   uid is rejected rather than silently overwriting, because two competing
   identities for one merchant is the defect this exists to end, not to duplicate.
   ══════════════════════════════════════════════════════════════════════════════ */
const LINKS = 'merchantAccountLinks';

/* Every uid that belongs to the same business as `uid` — including itself.
   Returns exactly [uid] when no link exists, so an unlinked account behaves
   precisely as it does today. */
async function linkedUids(uid) {
  if (!uid) return [];
  const self = _s(uid, 64);
  try {
    /* Canonical? */
    const own = await _db().collection(LINKS).doc(self).get();
    if (own.exists && _activeLink(own.data())) {
      return _dedupe([self].concat(own.data().linkedAccountUids || []));
    }
    /* Linked as a member? */
    const q = await _db().collection(LINKS)
      .where('linkedAccountUids', 'array-contains', self).limit(2).get();
    if (q.empty) return [self];
    /* Two canonical identities claiming one uid is ambiguous. Refuse to guess —
       returning just the uid keeps today's behaviour rather than picking one. */
    if (q.size > 1) return [self];
    const d = q.docs[0];
    if (!_activeLink(d.data())) return [self];
    return _dedupe([self, d.id].concat(d.data().linkedAccountUids || []));
  } catch (_) {
    /* A link store that cannot be read must not blank an account's own identity. */
    return [self];
  }
}

function _activeLink(d) { return !!d && _s(d.status, 20).toLowerCase() !== 'revoked'; }
function _dedupe(a) { const out = []; (a || []).forEach((x) => { const v = _s(x, 64); if (v && out.indexOf(v) === -1) out.push(v); }); return out; }

/* The canonical identity record for a uid, or null. */
async function merchantLink(uid) {
  const all = await linkedUids(uid);
  if (all.length <= 1) return null;
  for (const candidate of all) {
    const snap = await _db().collection(LINKS).doc(candidate).get().catch(() => null);
    if (snap && snap.exists && _activeLink(snap.data())) {
      return { canonicalUid: candidate, ...snap.data() };
    }
  }
  return null;
}

/* ── adminLinkMerchantAccounts — the ONLY way a link is created ──────────────
   Admin-only, refuses ambiguity, and records who did it and why. Deliberately
   does NOT move, copy or rewrite a subscription: the KES 499 record stays
   exactly as billing wrote it, and the link is what lets it be found. */
exports.adminLinkMerchantAccounts = onCall(OPTS, async ({ data, auth }) => {
  const uid = _uid(auth);
  const t = (auth && auth.token) || {};
  if (!t.admin && !t.superAdmin) throw new HttpsError('permission-denied', 'Admin access required.');

  const d = data || {};
  const canonicalUid = _s(d.canonicalUid, 64);
  const linked = _dedupe(d.linkedAccountUids || []);
  const shopId = _s(d.shopId, 64);
  const reason = _s(d.reason, 300);
  if (!canonicalUid) throw new HttpsError('invalid-argument', 'canonicalUid required');
  if (!linked.length) throw new HttpsError('invalid-argument', 'linkedAccountUids required');
  if (!reason) throw new HttpsError('invalid-argument', 'reason required — a link must be explainable');
  if (linked.indexOf(canonicalUid) > -1) {
    throw new HttpsError('invalid-argument', 'canonicalUid must not repeat in linkedAccountUids');
  }

  /* Every uid must be free of any other identity. */
  for (const u of [canonicalUid].concat(linked)) {
    const existing = await linkedUids(u);
    if (existing.length > 1) {
      throw new HttpsError('failed-precondition', 'uid already belongs to a merchant identity: ' + u);
    }
  }

  const rec = {
    canonicalUid: canonicalUid,
    linkedAccountUids: linked,
    shopId: shopId || null,
    reason: reason,
    /* Evidence is free-form but recorded — a payment ref, a ticket, a decision. */
    evidence: (d.evidence && typeof d.evidence === 'object') ? d.evidence : null,
    status: 'active',
    createdBy: uid,
    createdAt: _now(),
  };
  try {
    await _db().collection(LINKS).doc(canonicalUid).create(rec);
  } catch (_) {
    throw new HttpsError('already-exists', 'a link already exists for this canonicalUid');
  }
  return { ok: true, canonicalUid: canonicalUid, linkedAccountUids: linked, shopId: rec.shopId };
});

/* Internals exported for the certification suite. Not part of the callable API. */
exports._internal = {
  resolveActor, shopIdentity, ROLE_CAPABILITIES, OWNER_CAPABILITIES, EMPLOYEE_ROLES,
  CAPABILITIES, effectiveCapabilities,
  /* ACTIVE_EMPLOYMENT and _employmentActive were here. They were this file's
     private employment predicate over a `status` field no writer writes, and
     they had no consumer outside this file. Removed with the repair — the
     employee arm now consumes shop-employees.employeeRecordReasons. */
  employeeRecordReasons,
  LINKS, linkedUids, merchantLink,
};
