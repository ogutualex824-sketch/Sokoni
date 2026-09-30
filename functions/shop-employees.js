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
/* ── SHORT LABEL ──────────────────────────────────────────────────────────────
   A compact badge for the shop switcher: KS, KASS, NAP, M&M.

   A PURE FUNCTION OF THE CANONICAL SHOP NAME, and nothing else. Not of the
   viewer, not of the session, not of the caller's position in a list — that is
   what makes two employees of the same shop see the same badge, and the same
   employee see it again tomorrow. The client never invents it, because two
   clients would then disagree about the same shop.

   The rules, in order:
     1. no usable name                      -> SHOP
     2. first word is already a mark         -> that word        M&M Electronics -> M&M
        (<=4 chars AND carries a non-letter, e.g. & or a digit)
     3. several words                        -> their initials   Kass Shop       -> KS
                                                                 Nairobi Auto Parts -> NAP
     4. one short word                       -> the word         KASS            -> KASS
     5. one long word                        -> its first 5      Supermarket     -> SUPER

   COLLISIONS ARE NOT RESOLVED HERE, deliberately. "Kass Shop" and "Kim Stores"
   both yield KS, and that is correct: making the badge unique would require
   knowing the viewer's other shops, which would make it viewer-dependent and
   break the property above. The switcher shows shopName beside the badge, so
   the full name disambiguates. Never append a random suffix or an id fragment. */
function shortLabelFor(shopName) {
  const raw = String(shopName == null ? '' : shopName).replace(/\s+/g, ' ').trim();
  if (!raw) return 'SHOP';

  const words = raw.split(' ').filter(Boolean);
  const clean = (s) => String(s).toUpperCase().replace(/[^A-Z0-9&+-]/g, '');

  if (words.length > 1) {
    const first = clean(words[0]);
    /* An existing mark like M&M or 4U is already the shop's compact identity;
       reducing it to an initial would throw away the recognisable part. */
    if (first && first.length <= 4 && /[^A-Z]/.test(first)) return first.slice(0, 5);

    const initials = words.map((w) => clean(w).charAt(0)).filter(Boolean).join('');
    if (initials.length >= 2) return initials.slice(0, 5);
  }

  const one = clean(words.join(''));
  if (!one) return 'SHOP';
  return one.length <= 5 ? one : one.slice(0, 5);
}

function _workspaceEntry(shopId, shopData, role, via) {
  const shopName = _sanIdent(shopData && (shopData.name || shopData.storeName), 160) || 'My Shop';
  return {
    shopId,
    shopName,
    /* Derived on every read, never persisted: a stored copy would drift the
       moment an owner renamed the shop. */
    shortLabel: shortLabelFor(shopName),
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
/* ── RETIRED: three onCall duplicates ────────────────────────────────────────
   `listShopEmployees`, `listShopInvites` and `removeShopEmployee` were defined
   here as callables AND, independently, in functions/index.js. index.js requires
   this module for its HELPERS only and never re-exports these three, so Firebase
   deployed index.js's versions and these never ran — a parallel implementation of
   the employee rail that looked authoritative and was not.

   Removed rather than left in place: a second, better-documented implementation of
   a security rail is exactly the thing a future reader trusts by mistake. The live
   callables remain in index.js; the CONTRACT of this module — SHOP_ROLES,
   employeeDocId, resolveShopAccess, assertShopAccess, assertShopOwner,
   shopOwnerOf, resolveOwnedShopId — is unchanged and is what index.js and
   merchant-identity.js both build on.
   ─────────────────────────────────────────────────────────────────────────── */

/* ════════════════════════════════════════════════════════════════════════════
   listShopTeam — the team of ONE shop, for the owner OR a corroborated manager.

   WHY THIS EXISTS ALONGSIDE listShopEmployees
   listShopEmployees gates on assertShopOwner, so a manager cannot read the team
   at all. That was consistent while nothing below owner could act on the shop —
   but ab2d50a gave a corroborated manager authority over the roster, and a
   manager who may schedule people cannot see who they are. This closes that
   gap WITHOUT touching listShopEmployees, whose behaviour other surfaces already
   depend on and whose owner-only answer stays exactly as certified.

   IT ALSO RETURNS THE TENANT, which is the other half of the problem. The
   scheduler is addressed by sellerId; the client only ever holds a shopId, and
   the two are different identifiers. An owner could pass their own uid, but a
   manager has no way to name the tenant they work for — so the client would have
   to guess, and a guessed tenant is a client-selected one. `sellerId` here is
   resolveShopAccess's own shopOwnerId: derived from the shop document, never
   echoed from the request.

   SCOPED TO THE SHOP, deliberately. listShopEmployees queries by shopOwnerId and
   so returns every employee of every shop that owner holds; for a manager of one
   branch that would be a wider answer than the question. This asks by shopId.

   EMAIL IS OWNER-ONLY. A manager needs to know who is on the team and what they
   do — that is what rostering requires. Contact details are not part of that, so
   they are omitted rather than trimmed on the client, which would leave them on
   the wire.
   ════════════════════════════════════════════════════════════════════════════ */
exports.listShopTeam = onCall(
  { region: REGION, maxInstances: 20, memory: '256MiB', timeoutSeconds: 20, enforceAppCheck: true },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

    const shopId = String((req.data || {}).shopId || '').trim();
    if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required.');

    /* THE corroborated resolver, not a second copy of its rules. */
    const access = await resolveShopAccess(uid, shopId);
    const mayManage = access.via === 'owner' || access.via === 'admin' || access.role === 'manager';
    if (!mayManage) {
      throw new HttpsError('permission-denied', 'Only the shop owner or a manager can see the team.');
    }
    const full = access.via === 'owner' || access.via === 'admin';

    const snap = await _db().collection(EMPLOYEES)
      .where('shopId', '==', shopId)
      .limit(200).get();

    const employees = [];
    snap.forEach((d) => {
      const e = d.data() || {};
      if (e.active === false) return;                     /* a revoked record is not a member */
      if (!SHOP_ROLES.includes(e.role)) return;
      /* Same corroboration the resolver applies to the CALLER, applied to each
         row: a forged record filed under this shop must not be listed as staff. */
      if (!access.shopOwnerId || String(e.shopOwnerId || '') !== String(access.shopOwnerId)) return;
      const row = {
        uid: String(e.uid || '').trim(),
        name: _sanIdent(e.name, 120) || '',
        role: e.role,
        active: true,
      };
      if (!row.uid) return;
      if (full) row.email = String(e.email || '');
      employees.push(row);
    });

    /* The enforcement state, read from the shop document rather than inferred.
       The screen that offers the switch has to show what is actually true, and
       this module already has the caller authorised for this shop — a second
       round trip would only add a way for the two answers to disagree.

       An exact boolean, matching enforcementActive's own refusal to read a truthy
       value as consent: anything else in the field means OFF, and the UI is told
       OFF rather than being handed a value to interpret. */
    const shopSnap = await _db().collection(SHOPS).doc(shopId).get();
    const shiftEnforcement = ((shopSnap.data() || {}).shiftEnforcement === true);

    return {
      shopId,
      /* The AUTHORITATIVE tenant, from the shop document. */
      sellerId: access.shopOwnerId || null,
      role: access.role,
      via: access.via,
      shiftEnforcement,
      employees,
      count: employees.length,
    };
  }
);

exports.EMPLOYEES = EMPLOYEES;
exports.SHOP_ROLES = SHOP_ROLES;
exports.employeeDocId = employeeDocId;
exports.shortLabelFor = shortLabelFor;   /* pure; exported so the label rules are PROVED, not described */
exports.legacyEmployeeDocId = legacyEmployeeDocId;
exports.shopOwnerOf = shopOwnerOf;
exports.resolveShopAccess = resolveShopAccess;
exports.assertShopAccess = assertShopAccess;
exports.assertShopOwner = assertShopOwner;
exports.resolveOwnedShopId = resolveOwnedShopId;
exports.ROLE_CAPABILITIES = ROLE_CAPABILITIES;
exports.capabilitiesForRole = capabilitiesForRole;
exports._workspaceEntry = _workspaceEntry;
