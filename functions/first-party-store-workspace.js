'use strict';
/**
 * SOKONI STORE — operator workspace callables
 * functions/first-party-store-workspace.js
 *
 * The SOKONI Store is operated through these callables and nothing else. Each one calls
 * first-party-store-operator.assertStoreOperator() FIRST and addresses only the ids that
 * gate returns — never an id from the request. So:
 *
 *   · the named operator is served;
 *   · every other account, admin and superAdmin included, is refused with
 *     permission-denied / details.reason = 'not-store-operator' — BEFORE any store read;
 *   · a request cannot steer a callable at another shop, business or wallet: none of them
 *     accepts a shopId / businessId / uid parameter.
 *
 * Ported from 526f330 (slice/realtime-control-plane), re-modelled:
 *   526f330: any admin operates a `_platform` shop it provisions itself.
 *   here:    ONE operator operates the certified first-party chain
 *            (shops/STR_… firstParty → ownerId → the one SOKONI_FIRST_PARTY_STORE business).
 *   Not ported: sokoniStoreProvision (the store already exists and must not be re-minted),
 *   product write/delete (own slice — the product authority + stock invariant), and the
 *   commission / sellerBilling edits to index.js (they rebuild live payment functions).
 *
 * MONEY: read-only here. No wallet is created, credited or debited by any callable in this
 * file, and no payout destination is written here — withdrawals live in
 * first-party-store-payout.js (held behind a server-only flag). See docs/SOKONI_STORE_OPERATOR_CENSUS.md.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const OP = require('./first-party-store-operator');

const OPTS = { region: 'us-central1', maxInstances: 10, memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: true };
const AUDIT = 'firstPartyStoreAudit';   /* server-only: no rules match → clients denied */

function _db() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

/* Handler registry — the suites drive the REAL handlers without the onCall wrapper. */
const _h = {};
exports._h = _h;

/** Unknown stays unknown: a missing number is null, never 0. */
const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const _ms = (v) => {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return null;
};

/** Kenyan mobile → E.164 (+2547XXXXXXXX / +2541XXXXXXXX), or null. */
function normalizeKePhone(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s\-()]/g, '');
  let m = s.match(/^\+?254([17]\d{8})$/);
  if (m) return '+254' + m[1];
  m = s.match(/^0([17]\d{8})$/);
  if (m) return '+254' + m[1];
  return null;
}

/** Last three digits only. Never more — the full number is not the operator console's business to echo. */
function maskTail(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 3 ? '••• ' + d.slice(-3) : null;
}

async function _audit(db, gate, action, detail) {
  try {
    await db.collection(AUDIT).add({
      action: 'sokoniStore.' + action,
      operatorUid: gate.uid,
      storeId: gate.storeId,
      businessId: gate.businessId,
      detail: detail || {},
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('[sokoniStore] audit write failed', action, e && e.message);
  }
}

/** The public-profile projection the workspace edits. */
/** Server-only destination → the client sees last 3 digits only. */
function _destinationOf(record) {
  const d = record && record.payoutDestination;
  const digits = d && typeof d.msisdn === 'string' ? d.msisdn.replace(/\D/g, '') : '';
  return digits.length >= 3 ? { status: 'set', last3: digits.slice(-3) } : { status: 'not-set' };
}

function _profileOf(shop) {
  const s = shop || {};
  return {
    name: s.name || s.storeName || null,
    storeName: s.storeName || null,
    tagline: s.tagline || null,
    description: s.description || s.about || null,
    phone: s.phone || s.phoneNumber || null,
    email: s.email || null,
    address: s.address || null,
    city: s.city || null,
    logo: s.logo || s.logoUrl || null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   CONTEXT — the only call the workspace makes before rendering anything.
   ══════════════════════════════════════════════════════════════════════════════ */
_h.sokoniStoreGetContext = async (req, dbOverride) => {
  const db = dbOverride || _db();
  const gate = await OP.assertStoreOperator(req, db);
  return {
    ok: true,
    operator: true,
    storeId: gate.storeId,
    businessId: gate.businessId,
    businessName: gate.business.name || gate.business.businessName || null,
    profile: _profileOf(gate.shop),
    payoutDestination: _destinationOf(gate.record),
    payoutsEnabled: await require('./first-party-store-payout')._internal.flagOn(db),
  };
};

/* ══════════════════════════════════════════════════════════════════════════════
   PROFILE — contact phone and the public storefront fields.
   Sanitised by kasshop's OWN allowlist (never a copy); written to the store's shop
   document only, inside a transaction that re-proves the chain; never writes
   sellerUid / ownerId / firstParty / status.
   ══════════════════════════════════════════════════════════════════════════════ */
const STORE_PROFILE_FIELDS = Object.freeze([
  'name', 'storeName', 'tagline', 'about', 'description', 'phone', 'email',
  'website', 'address', 'city', 'mapsLink', 'logo', 'logoUrl', 'banner', 'bannerUrl',
]);

_h.sokoniStoreSaveProfile = async (req, dbOverride) => {
  const db = dbOverride || _db();
  const gate = await OP.assertStoreOperator(req, db);

  const { cleanProfile } = require('./kasshop')._internal;
  const cleaned = cleanProfile((req.data || {}).profile);
  const patch = {};
  for (const k of STORE_PROFILE_FIELDS) if (k in cleaned) patch[k] = cleaned[k];

  if ('phone' in patch) {
    const e164 = normalizeKePhone(patch.phone);
    if (!e164) {
      throw new HttpsError('invalid-argument', 'Enter a valid Kenyan phone number, e.g. 0705 726 803.',
        { reason: 'invalid-phone' });
    }
    patch.phone = e164;
  }
  if ('name' in patch && !patch.name) {
    throw new HttpsError('invalid-argument', 'The store needs a name.', { reason: 'name-required' });
  }
  if (!Object.keys(patch).length) {
    throw new HttpsError('invalid-argument', 'Nothing to save.', { reason: 'empty-patch' });
  }

  const ref = db.collection('shops').doc(gate.storeId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const s = snap.exists ? (snap.data() || {}) : null;
    /* Re-prove inside the write: a store re-designated or re-owned between the gate and
       this commit is not the store the operator was authorised for. */
    if (!s || s.firstParty !== true || String(s.ownerId || '') !== gate.ownerUid ||
        (s.sellerUid != null && s.sellerUid !== '')) {
      throw new HttpsError('failed-precondition', 'The SOKONI Store changed. Reload and try again.',
        { reason: 'chain-changed' });
    }
    tx.update(ref, Object.assign({}, patch, { updatedAt: new Date() }));
  });

  await _audit(db, gate, 'saveProfile', { fields: Object.keys(patch) });
  return { ok: true, fields: Object.keys(patch), profile: _profileOf(Object.assign({}, gate.shop, patch)) };
};

/* ══════════════════════════════════════════════════════════════════════════════
   PRODUCTS — read-only list. Store goods are filed under the shop (shopId) or the
   business (sellerUid = businessId, the shape store orders carry); both are read and
   de-duplicated. Absent stock is UNMETERED (null), never 0.
   ══════════════════════════════════════════════════════════════════════════════ */
_h.sokoniStoreListProducts = async (req, dbOverride) => {
  const db = dbOverride || _db();
  const gate = await OP.assertStoreOperator(req, db);
  const [byShop, byBiz] = await Promise.all([
    db.collection('products').where('shopId', '==', gate.storeId).limit(100).get(),
    db.collection('products').where('sellerUid', '==', gate.businessId).limit(100).get(),
  ]);
  const seen = new Map();
  for (const d of [...byShop.docs, ...byBiz.docs]) {
    if (seen.has(d.id)) continue;
    const p = d.data() || {};
    seen.set(d.id, {
      id: d.id,
      name: p.name || p.title || null,
      price: _num(p.price),
      stock: _num(p.stock),
      status: p.status || null,
      image: p.image || (Array.isArray(p.images) ? p.images[0] : null) || null,
    });
  }
  const products = [...seen.values()];
  return { ok: true, products, count: products.length, truncated: byShop.size >= 100 || byBiz.size >= 100 };
};

/* ══════════════════════════════════════════════════════════════════════════════
   ORDERS — read-only, newest first. Store orders carry sellerUid = the BUSINESS id.
   Index: orders(sellerUid ASC, createdAt DESC) — present in firestore.indexes.json.
   No buyer PII in the list.
   ══════════════════════════════════════════════════════════════════════════════ */
_h.sokoniStoreListOrders = async (req, dbOverride) => {
  const db = dbOverride || _db();
  const gate = await OP.assertStoreOperator(req, db);
  const snap = await db.collection('orders')
    .where('sellerUid', '==', gate.businessId)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  const orders = snap.docs.map((d) => {
    const o = d.data() || {};
    return {
      id: d.id,
      status: o.status || null,
      paymentStatus: o.paymentStatus || null,
      settlementStatus: o.settlementStatus || null,
      total: _num(o.total != null ? o.total : o.totalAmount),
      currency: o.currency || 'KES',
      itemCount: Array.isArray(o.items) ? o.items.length : null,
      createdAt: _ms(o.createdAt),
    };
  });
  return { ok: true, orders, count: orders.length };
};

/* ══════════════════════════════════════════════════════════════════════════════
   WALLET — read-only. The store wallet is wallets/{businessId} = wallets/SOK-XX2338: where
   the LIVE settlement path (order-settlement: wallets/{order.sellerUid}) credits store sales
   (owner decision 2026-10-01, proven from the live onOrderStatusChange archive). It is created
   by the first settled sale — never here. Absent = settled:false, balance null (never 0).
   ══════════════════════════════════════════════════════════════════════════════ */
_h.sokoniStoreGetWallet = async (req, dbOverride) => {
  const db = dbOverride || _db();
  const gate = await OP.assertStoreOperator(req, db);
  const snap = await db.collection('wallets').doc(gate.businessId).get();
  const w = snap.exists ? (snap.data() || {}) : null;
  return {
    ok: true,
    storeWallet: {
      walletId: gate.businessId,
      exists: !!w,
      settled: !!w,
      state: w ? 'active' : 'no-sale-settled-yet',
      balance: w ? _num(w.balance) : null,          /* SHILLINGS (wallets/* convention) */
      pendingPayout: w ? _num(w.pendingPayout) : null,
      currency: (w && w.currency) || 'KES',
      frozen: w ? w.frozen === true : null,
    },
    payoutDestination: _destinationOf(gate.record),
    payoutsEnabled: await require('./first-party-store-payout')._internal.flagOn(db),
  };
};

exports.sokoniStoreGetContext   = onCall(OPTS, (req) => _h.sokoniStoreGetContext(req));
exports.sokoniStoreSaveProfile  = onCall(OPTS, (req) => _h.sokoniStoreSaveProfile(req));
exports.sokoniStoreListProducts = onCall(OPTS, (req) => _h.sokoniStoreListProducts(req));
exports.sokoniStoreListOrders   = onCall(OPTS, (req) => _h.sokoniStoreListOrders(req));
exports.sokoniStoreGetWallet    = onCall(OPTS, (req) => _h.sokoniStoreGetWallet(req));

exports._internal = Object.freeze({ normalizeKePhone, maskTail, STORE_PROFILE_FIELDS });
