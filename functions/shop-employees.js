'use strict';
/**
 * SOKONI Shop Employees — the ONE contract for "who works at this shop".
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * The 2D-2 authority census found `shopEmployees` had TWO incompatible document
 * key schemes, and that the only writer used the one no reader looks up:
 *
 *   WRITER   acceptShopInvite        shopEmployees/{uid}
 *   reader   analytics-engine        shopEmployees/{shopId}_{uid}
 *   reader   merchantAdjustStock     shopEmployees/{shopId}_{uid}
 *
 * So an employee who accepted an invite was invisible to every reader: both fell
 * through to their permission-denied branch. Employee access has never worked in
 * production — including in the Inventory surface shipped at 2D-1C, whose
 * "employees may adjust stock" path could not match a real record.
 *
 * ── The worse defect underneath it ──────────────────────────────────────────
 * Both readers granted access on `empSnap.exists` ALONE. `firestore.rules` lets
 * any signed-in client create a `shopEmployees` document at an arbitrary id
 * provided it sets `shopOwnerId` to itself:
 *
 *   allow create: if isAuthed() && request.resource.data.shopOwnerId == request.auth.uid;
 *
 * So a client could write `shopEmployees/{SHOP_C}_{attackerUid}` naming itself
 * owner and be recognised as SHOP_C staff. The key divergence never protected
 * against this — it only hid the LEGITIMATE employee while leaving the forged
 * one perfectly readable.
 *
 * The fix is CORROBORATION, and it is deliberately server-side: an employee
 * record is believed only when the SHOP DOCUMENT agrees with it. A forged record
 * names the attacker as owner; `shops/{shopId}` names the real one; they differ,
 * and access is refused. That closes the hole without a `firestore.rules` change
 * — which matters, because the compiled ruleset has ~72 bytes of headroom and an
 * over-size ruleset uploads but cannot activate.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *   doc id     shopEmployees/{shopId}_{uid}        — ALWAYS constructed, never parsed
 *   believed   iff  shopId matches, uid matches, active !== false,
 *                   role is a known shop role, AND shopOwnerId === the shop's
 *                   actual owner from `shops/{shopId}`
 *   legacy     shopEmployees/{uid} is NEVER honoured. Not read, not migrated,
 *              not silently upgraded. Establishing the contract comes first;
 *              migrating existing records is separate, deliberate work.
 *   identity   `sellerUid` is the ACCOUNT, `shopId` is the SHOP. Neither is ever
 *              defaulted to the other — there is no uid-as-shop fallback here.
 *
 * ── Shop ownership is itself divergent (recorded, not silently resolved) ────
 * `shops` documents carry ownership under `ownerId` (analytics-engine,
 * merchant-inventory, logistics-plus, finance-os) OR `sellerUid` (minishop,
 * minishop-v3) OR `ownerUid` (kasshop). This module READS the union, exactly as
 * `kasshop.js:514` already does, so it cannot refuse a legitimate owner because
 * their shop was written by a different subsystem. That tolerance is on the READ
 * side only; converging the WRITE side is separate work. It is not an identity
 * fallback: the shop document still decides, and a uid never stands in for a shop.
 *
 * Exports (re-exported by name from functions/index.js):
 *   listShopEmployees     onCall  — owner/admin: the staff of one shop
 *   removeShopEmployee    onCall  — owner/admin: deactivate one employee
 *   merchantIdentity      onCall  — any authenticated caller: capabilities +
 *                          shop projection for ONE shopId, built on
 *                          resolveShopAccess. merchant-v2.html's own core
 *                          identity step — was a missing dependency on this
 *                          branch until now (Till Approval Automation +
 *                          Unified Dashboard Profile, Part 3).
 *   getMyShopWorkspaces   onCall  — any authenticated caller: EVERY shop
 *                          (owned or corroborated-employee) they may
 *                          operate. Powers Switch Shop + the login
 *                          "Choose Shop" step (Part 4).
 * Plus the internal contract used by other authorities:
 *   employeeDocId, resolveShopAccess, assertShopAccess, shopOwnerOf, SHOP_ROLES
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const REGION = 'us-central1';
const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();

const EMPLOYEES = 'shopEmployees';
const SHOPS = 'shops';

/* The vocabulary a shop employee role may take. A record carrying anything else
   is not a shop employee record, whatever it claims. */
const SHOP_ROLES = Object.freeze(['cashier', 'manager', 'inventory', 'support']);

/**
 * The canonical document id. ALWAYS constructed, never parsed — a composite key
 * is only ambiguous if you try to split it back apart, and nothing here does.
 */
function employeeDocId(shopId, uid) {
  if (!shopId || !uid) throw new HttpsError('invalid-argument', 'shopId and uid are both required.');
  return `${String(shopId)}_${String(uid)}`;
}

/** The legacy id this module refuses to honour. Exported so a test can assert the refusal. */
function legacyEmployeeDocId(uid) { return String(uid); }

/**
 * Ownership as the SHOP DOCUMENT states it. Returns the owner uid, or null.
 * Reads the union of the field names in production use — see the header.
 */
function shopOwnerOf(shopData) {
  if (!shopData) return null;
  return shopData.ownerId || shopData.sellerUid || shopData.ownerUid || null;
}

/**
 * Resolve what `uid` may do at `shopId`, from DATA — never from a claim, and
 * never from the caller's own assertion.
 *
 * Returns { role, via } where via is 'owner' | 'employee' | 'admin'.
 * Throws HttpsError otherwise, so a client receives a code it can act on.
 */
async function resolveShopAccess(uid, shopId) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required.');

  const db = _db();
  const shopSnap = await db.collection(SHOPS).doc(String(shopId)).get();
  if (!shopSnap.exists) throw new HttpsError('not-found', 'Shop not found.');
  const shop = shopSnap.data() || {};

  const ownerUid = shopOwnerOf(shop);
  if (ownerUid && ownerUid === uid) return { role: 'owner', via: 'owner', shopOwnerId: ownerUid };

  /* Employee — believed only if the shop document corroborates the record. */
  const empSnap = await db.collection(EMPLOYEES).doc(employeeDocId(shopId, uid)).get();
  if (empSnap.exists) {
    const e = empSnap.data() || {};
    const reasons = [];
    /* The record must name the shop it is filed under and the person it is for.
       Without this a document copied between shops would still read as valid. */
    if (String(e.shopId || '') !== String(shopId)) reasons.push('shopId mismatch');
    if (e.uid && String(e.uid) !== String(uid)) reasons.push('uid mismatch');
    if (e.active === false) reasons.push('inactive');
    if (!SHOP_ROLES.includes(e.role)) reasons.push('unknown role');
    /* THE corroboration. A client-forged record names the forger as owner; the
       shop document names the real owner; they will not agree. */
    if (!ownerUid || String(e.shopOwnerId || '') !== String(ownerUid)) reasons.push('shopOwnerId does not match the shop document');

    if (!reasons.length) return { role: e.role, via: 'employee', shopOwnerId: ownerUid };
    /* A record that fails corroboration is NOT access, and is NOT an error the
       caller can distinguish from having no record at all — saying which check
       failed would tell a prober how to shape a better forgery. */
  }

  /* Platform admin, from claims — the one thing a client cannot forge. */
  try {
    const claims = (await getAuth().getUser(uid)).customClaims || {};
    if (claims.admin === true || claims.superAdmin === true ||
        claims.role === 'admin' || claims.role === 'superAdmin') {
      return { role: 'admin', via: 'admin', shopOwnerId: ownerUid };
    }
  } catch (_) { /* an unresolvable account is simply not an admin */ }

  throw new HttpsError('permission-denied', 'You do not have access to this shop.');
}

/** Convenience wrapper returning just the role string. */
async function assertShopAccess(uid, shopId) {
  return (await resolveShopAccess(uid, shopId)).role;
}

/** Owner (or platform admin) only — for staff management. */
async function assertShopOwner(uid, shopId) {
  const r = await resolveShopAccess(uid, shopId);
  if (r.via !== 'owner' && r.via !== 'admin') {
    throw new HttpsError('permission-denied', 'Only the shop owner can manage staff.');
  }
  return r;
}

/**
 * Resolve the shop a caller owns, when the caller did not name one.
 *
 * This is a LOOKUP, not a fallback: it queries `shops` for a document this uid
 * owns and returns that document's own id. It never returns the uid as a shop id
 * — an account that owns no shop resolves to null and the caller is refused.
 */
async function resolveOwnedShopId(uid) {
  const db = _db();
  /* shops/{uid} is the common shape (a merchant's shop keyed by their uid), and
     it is confirmed by READING the document rather than assumed. */
  const direct = await db.collection(SHOPS).doc(String(uid)).get();
  if (direct.exists && shopOwnerOf(direct.data()) === uid) return direct.id;

  for (const field of ['ownerId', 'sellerUid', 'ownerUid']) {
    const q = await db.collection(SHOPS).where(field, '==', uid).limit(2).get();
    if (!q.empty) {
      if (q.size > 1) {
        throw new HttpsError('failed-precondition',
          'This account owns more than one shop. Name the shop explicitly (shopId).');
      }
      return q.docs[0].id;
    }
  }
  return null;
}

/** One workspace-list entry. `role`/`via` mirror resolveShopAccess's own
    vocabulary so a consumer never has to learn a second one. */
function _workspaceEntry(shopId, shopData, role, via) {
  return {
    shopId,
    shopName: _sanIdent(shopData && (shopData.name || shopData.storeName), 160) || 'My Shop',
    role,
    via,
    isActive: !shopData || shopData.status !== 'suspended',
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   getMyShopWorkspaces — every shop the AUTHENTICATED caller may operate,
   server-derived, never a client-supplied list (Till Approval Automation +
   Unified Dashboard Profile, Part 4). Powers "Switch Shop" and the login
   "Choose Shop" step alike — ONE resolver, not two.

   Scoped deliberately to the shops/shopEmployees tenant space only — the
   same one merchant-v2.html and merchantIdentity already operate in.
   functions/workforce-identity.js's separate businesses/workspaceMemberships
   space (a different, POS-shift-oriented tenant model, per
   functions/tenant-identity.js's own "two disjoint tenant spaces" framing)
   is a deliberate non-goal here, not an oversight.

   Uses the SAME corroboration resolveShopAccess already enforces (an
   employee record is believed only when the shop document's own owner field
   agrees with it) — reimplemented as a scan rather than a single lookup,
   because listing requires finding candidates BEFORE their shopId is known,
   which resolveShopAccess (built for "what may I do at THIS shop") cannot
   do. Every corroboration check it performs is performed here too; none are
   relaxed for the sake of building a list.
   ════════════════════════════════════════════════════════════════════════════ */
exports.getMyShopWorkspaces = onCall(
  { region: REGION, maxInstances: 20, memory: '256MiB', timeoutSeconds: 20, enforceAppCheck: true },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

    const db = _db();
    const workspaces = [];
    const seen = new Set();

    /* ── Owned shops ─────────────────────────────────────────────────────
       shops/{uid} is the common shape, checked first. The field-union scan
       (mirroring resolveOwnedShopId's own field list) catches the less
       common shapes WITHOUT that function's single-shop limitation — it
       throws if an account owns more than one; a list has no such
       constraint to violate. */
    const directSnap = await db.collection(SHOPS).doc(uid).get();
    if (directSnap.exists && shopOwnerOf(directSnap.data()) === uid) {
      workspaces.push(_workspaceEntry(directSnap.id, directSnap.data(), 'owner', 'owner'));
      seen.add(directSnap.id);
    }
    for (const field of ['ownerId', 'sellerUid', 'ownerUid']) {
      const q = await db.collection(SHOPS).where(field, '==', uid).get();
      q.forEach((d) => {
        if (seen.has(d.id)) return;
        const s = d.data() || {};
        if (shopOwnerOf(s) !== uid) return; /* the field alone is not the corroboration; shopOwnerOf's own union is */
        workspaces.push(_workspaceEntry(d.id, s, 'owner', 'owner'));
        seen.add(d.id);
      });
    }

    /* ── Employee memberships — corroborated exactly like resolveShopAccess ── */
    const empSnap = await db.collection(EMPLOYEES).where('uid', '==', uid).get();
    for (const doc of empSnap.docs) {
      const e = doc.data() || {};
      if (e.active === false) continue;
      if (!SHOP_ROLES.includes(e.role)) continue;
      const shopId = String(e.shopId || '');
      if (!shopId || seen.has(shopId)) continue;

      const shopSnap = await db.collection(SHOPS).doc(shopId).get();
      if (!shopSnap.exists) continue;
      const s = shopSnap.data() || {};
      const ownerUid = shopOwnerOf(s);
      /* THE corroboration, unchanged from resolveShopAccess: a forged record
         names the forger as owner; the real shop document names the real
         one; they will not agree, and the candidate is silently dropped —
         never surfaced as "denied" (which would tell a prober which check
         failed), just absent from the list, exactly as resolveShopAccess
         itself never distinguishes "no record" from "corroboration failed". */
      if (!ownerUid || String(e.shopOwnerId || '') !== String(ownerUid)) continue;

      workspaces.push(_workspaceEntry(shopId, s, e.role, 'employee'));
      seen.add(shopId);
    }

    return { workspaces };
  }
);

/* Capabilities per resolved role — first defined here. Nothing on this branch
   had a ROLE_CAPABILITIES table before (the one merchant-v2.html's own
   comments describe living in functions/merchant-identity.js exists only on
   a different, unmerged branch, release/merchant-identity). `'sell'` is the
   only capability any current shell code actually checks (merchant-v2.html's
   `can('sell')`, gating the POS/till surface) — the rest is forward-looking,
   conservative scaffolding for the same SHOP_ROLES vocabulary
   resolveShopAccess already resolves, not an assumption ported from
   elsewhere. Owner/admin get everything; a role of narrower, undefined scope
   ('support') gets nothing beyond being recognised, on the principle that an
   unreviewed capability grant is a worse default than an under-permissioned
   one a real product decision can widen later. */
const ROLE_CAPABILITIES = Object.freeze({
  owner:     ['sell', 'discount', 'refund', 'staff', 'settings', 'reports', 'till'],
  admin:     ['sell', 'discount', 'refund', 'staff', 'settings', 'reports', 'till'],
  manager:   ['sell', 'discount', 'refund', 'staff', 'reports', 'till'],
  cashier:   ['sell', 'till'],
  inventory: ['inventory', 'reports'],
  support:   [],
});

function _sanIdent(s, max) {
  return String(s || '').replace(/[<>]/g, '').trim().slice(0, max || 160);
}

/** Pure — no Firestore. An unrecognised/malformed role (never expected from
    resolveShopAccess, which only ever returns 'owner'/'admin'/SHOP_ROLES, but
    checked here anyway rather than trusted) resolves to NO capabilities, not
    every capability — the fail-closed direction is the only safe default for
    a lookup table indexed by a value this function does not itself verify. */
function capabilitiesForRole(role) {
  /* .slice() — ROLE_CAPABILITIES itself is frozen, but Object.freeze is
     shallow: the ARRAYS it holds are not, so returning them directly would
     hand every caller a live reference to the shared table. A caller that
     mutated its own "copy" would corrupt every future resolution for that
     role — certified directly (scripts/test-merchant-identity.js). */
  return (ROLE_CAPABILITIES[role] || []).slice();
}

/* ════════════════════════════════════════════════════════════════════════════
   merchantIdentity — resolve WHAT an authenticated caller may do at shopId,
   and the shop's own display projection. merchant-v2.html has called this
   exact callable, with this exact request/response shape, since before this
   file existed on this branch (its own comments describe the contract in
   detail) — this was a missing dependency, not new API surface invented for
   this slice. ONE source of truth for owners and employees alike, built
   directly on resolveShopAccess's already-corroborated resolution — no
   capability is ever mirrored from the client, and a client that names a
   shopId cannot assert its own relationship to it.
   ════════════════════════════════════════════════════════════════════════════ */
exports.merchantIdentity = onCall(
  { region: REGION, maxInstances: 20, memory: '128MiB', timeoutSeconds: 20, enforceAppCheck: true },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

    const shopId = String((req.data || {}).shopId || '').trim();
    if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required.');

    /* Never re-thrown as a generic 'internal' — resolveShopAccess's own codes
       (not-found / permission-denied / unauthenticated) are exactly what the
       caller needs to distinguish "no such shop" from "not your shop". */
    const access = await resolveShopAccess(uid, shopId);
    const capabilities = capabilitiesForRole(access.role);

    const shopSnap = await _db().collection(SHOPS).doc(shopId).get();
    const s = shopSnap.exists ? (shopSnap.data() || {}) : {};
    /* A projection, deliberately — merchant-v2.html's own comment states it
       prefers a direct shops/{uid} read when the caller already has one and
       falls back to this only "when the direct read was not ours to make"
       (the employee path, which cannot read another owner's full document
       under firestore.rules). */
    const shop = {
      name:  _sanIdent(s.name || s.storeName, 160),
      logo:  s.logo || s.logoUrl || null,
      phone: s.phone || s.phoneNumber || null,
      email: s.email || null,
      address: s.address || null,
      city:  s.city || null,
    };

    return { capabilities, shop, servedBy: access.via, role: access.role };
  }
);

/* ════════════════════════════════════════════════════════════════════════════
   listShopEmployees — the staff of ONE shop, for the owner of that shop.
   ════════════════════════════════════════════════════════════════════════════ */
exports.listShopEmployees = onCall(
  { region: REGION, maxInstances: 20, memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: true },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to view your team.');

    let shopId = req.data && req.data.shopId ? String(req.data.shopId).slice(0, 200) : null;
    if (!shopId) {
      shopId = await resolveOwnedShopId(uid);
      if (!shopId) throw new HttpsError('failed-precondition', 'This account does not own a shop yet.');
    }
    await assertShopOwner(uid, shopId);

    const db = _db();
    const snap = await db.collection(EMPLOYEES).where('shopId', '==', shopId).limit(200).get();
    const shopSnap = await db.collection(SHOPS).doc(shopId).get();
    const ownerUid = shopOwnerOf(shopSnap.data());

    /* Every row is corroborated the same way access is, so the screen cannot show
       a forged record as though it were staff. */
    const employees = [];
    snap.forEach((d) => {
      const e = d.data() || {};
      if (d.id !== employeeDocId(shopId, e.uid)) return;            /* not on the canonical key */
      if (!SHOP_ROLES.includes(e.role)) return;
      if (!ownerUid || String(e.shopOwnerId || '') !== String(ownerUid)) return;
      employees.push({
        id: d.id,
        uid: e.uid || null,
        email: e.email || null,
        name: e.name || null,
        role: e.role,
        active: e.active !== false,
        joinedAt: e.joinedAt || null,
      });
    });

    return { ok: true, shopId, employees, count: employees.length };
  }
);

/* ════════════════════════════════════════════════════════════════════════════
   listShopInvites — the invites OUTSTANDING for one shop.

   A team screen that shows only accepted staff is telling half the truth: the
   owner has no way to see who was invited, whether the link is still live, or
   why someone they invited has not appeared. Scoped to the shop, owner-only.

   Invites created before the shopId convergence carry no `shopId`, so they
   cannot be listed against a shop. They are surfaced under `staleCount` — an
   honest "these exist and can no longer be accepted" rather than a silent
   omission that makes an owner re-invite blindly.
   ════════════════════════════════════════════════════════════════════════════ */
exports.listShopInvites = onCall(
  { region: REGION, maxInstances: 20, memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: true },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to view invites.');

    let shopId = req.data && req.data.shopId ? String(req.data.shopId).slice(0, 200) : null;
    if (!shopId) {
      shopId = await resolveOwnedShopId(uid);
      if (!shopId) throw new HttpsError('failed-precondition', 'This account does not own a shop yet.');
    }
    await assertShopOwner(uid, shopId);

    const db = _db();
    /* Scoped by the INVITER as well as the shop: shopOwnerId is what
       revokeShopInvite authorises against, so listing by it keeps the two
       operations describing the same set. */
    const snap = await db.collection('shopInvites').where('shopOwnerId', '==', uid).limit(200).get();

    const now = Date.now();
    const invites = [];
    let staleCount = 0;
    snap.forEach((d) => {
      const v = d.data() || {};
      if (!v.shopId) { if (v.status === 'pending') staleCount++; return; }
      if (String(v.shopId) !== String(shopId)) return;
      if (v.status !== 'pending') return;
      let expiresMs = null;
      try { expiresMs = v.expiresAt && v.expiresAt.toMillis ? v.expiresAt.toMillis() : null; } catch (_) {}
      invites.push({
        token: d.id,
        email: v.email || null,
        role: v.role || null,
        createdAt: v.createdAt || null,
        expiresAt: v.expiresAt || null,
        expired: expiresMs != null ? expiresMs < now : null,
      });
    });

    return { ok: true, shopId, invites, count: invites.length, staleCount };
  }
);

/* ════════════════════════════════════════════════════════════════════════════
   removeShopEmployee — deactivate, never hard-delete.

   A removed employee is evidence: who had access to a till, and until when. The
   record is marked inactive so `resolveShopAccess` refuses it immediately, and
   the history survives.
   ════════════════════════════════════════════════════════════════════════════ */
exports.removeShopEmployee = onCall(
  { region: REGION, maxInstances: 20, memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: true },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

    const d = req.data || {};
    const targetUid = d.uid ? String(d.uid).slice(0, 200) : '';
    let shopId = d.shopId ? String(d.shopId).slice(0, 200) : null;
    if (!targetUid) throw new HttpsError('invalid-argument', 'uid is required.');
    if (!shopId) {
      shopId = await resolveOwnedShopId(uid);
      if (!shopId) throw new HttpsError('failed-precondition', 'This account does not own a shop yet.');
    }
    await assertShopOwner(uid, shopId);

    /* An owner cannot remove themselves through the staff screen — that would be
       an accidental self-lockout from their own shop. */
    if (targetUid === uid) throw new HttpsError('failed-precondition', 'You cannot remove yourself from your own shop.');

    const db = _db();
    const ref = db.collection(EMPLOYEES).doc(employeeDocId(shopId, targetUid));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'That person is not on this shop\'s team.');

    await ref.update({
      active: false,
      removedAt: _ts(),
      removedBy: uid,
    });

    return { ok: true, shopId, uid: targetUid, active: false };
  }
);

/* Internal contract, for the other authorities that must agree with it. */
exports.EMPLOYEES = EMPLOYEES;
exports.SHOP_ROLES = SHOP_ROLES;
exports.employeeDocId = employeeDocId;
exports.legacyEmployeeDocId = legacyEmployeeDocId;
exports.shopOwnerOf = shopOwnerOf;
exports.resolveShopAccess = resolveShopAccess;
exports.assertShopAccess = assertShopAccess;
exports.assertShopOwner = assertShopOwner;
exports.resolveOwnedShopId = resolveOwnedShopId;
exports.ROLE_CAPABILITIES = ROLE_CAPABILITIES;
exports.capabilitiesForRole = capabilitiesForRole;
exports._workspaceEntry = _workspaceEntry;
