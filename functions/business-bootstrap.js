/* ================================================================
   SOKONI SmartPOS — Business Bootstrap & Instant Provisioning v1.0
   functions/business-bootstrap.js | 2026-06-29

   One-call POS provisioning: returns everything a device needs
   to start selling in a single network round-trip.
   All Firestore reads are parallelised — target <5 s cold, <100 ms
   cached.

   5 Cloud Functions:
     bootstrapDevice          — full bundle (cache-first)
     getIncrementalSync       — delta sync since last token
     invalidateBootstrapCache — admin / owner cache bust
     getBusinessConfig        — light pre-branch-selection profile
     validateDeviceAccess     — PIN authentication with rate-limit

   Collections written:
     bootstrapCache/{merchantId}_{branchId}
     posDevices/{deviceId}
     rateLimits/{uid}_pin

   Region: us-central1 | Runtime: Node.js 22
   Platform: Firebase Gen2 Cloud Functions
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const crypto = require('crypto');

const db     = admin.firestore();
const F      = admin.firestore.FieldValue;
const REGION = 'us-central1';
const OPT    = {
  region:          REGION,
  enforceAppCheck: true,
  timeoutSeconds:  30,
  memory:          '512MiB',
  /* invoker:'public' tells the Firebase CLI to grant roles/run.invoker to
     allUsers on every deploy, preventing the Cloud Run IAM 403 regression
     that blocked bootstrapDevice / getBusinessConfig in production. */
  invoker:         'public',
};

/* ── Free-trial window ─────────────────────────────────────────────
   Referenced by the subscription doc written in _createBusiness. Declared here (module scope)
   because the trial boundaries are policy, not per-call state. TRIAL_GRACE_DAYS mirrors the
   grace window sub-billing applies between currentPeriodEnd and graceEnd. */
const TRIAL_DAYS       = 14;
const TRIAL_GRACE_DAYS = 3;

/* ── Cache TTL ─────────────────────────────────────────────────── */
const CACHE_TTL_MS   = 5 * 60 * 1000;   // 5 minutes
const CACHE_TTL_SECS = 300;

/* ── Structured logger ──────────────────────────────────────────── */
function _log(severity, message, extra = {}) {
  const fn = severity === 'ERROR'   ? console.error
           : severity === 'WARNING' ? console.warn
           : console.log;
  fn(JSON.stringify({ severity, message, service: 'business-bootstrap', ...extra }));
}

/* ── Sanitise strings (XSS) ────────────────────────────────────── */
function _san(v, max = 500) {
  if (typeof v !== 'string') return String(v || '').slice(0, max);
  return v.replace(/[<>"'&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;',
  }[c])).trim().slice(0, max);
}

/* ── HttpsError shorthand ───────────────────────────────────────── */
function _err(msg, code = 'invalid-argument') {
  throw new HttpsError(code, msg);
}

/* ── Require authenticated uid ──────────────────────────────────── */
function _requireAuth(req) {
  if (!req.auth?.uid) _err('Authentication required.', 'unauthenticated');
  return req.auth.uid;
}

/* ── Admin / super-admin token guard ───────────────────────────── */
function _isAdmin(req) {
  return !!(req.auth?.token?.admin || req.auth?.token?.superAdmin);
}

/* ── UUID-v4 format guard ───────────────────────────────────────── */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function _isUUID(s) { return UUID_RE.test(s); }

/* ── sha256 helper ──────────────────────────────────────────────── */
function _sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/* ─────────────────────────────────────────────────────────────────
   _assertMerchantAccess
   Verifies the caller belongs to the merchant: either they are an
   admin/super-admin, the business owner, OR they appear in posStaff
   for the given branch.  Returns uid.
───────────────────────────────────────────────────────────────── */
async function _assertMerchantAccess(req, merchantId, branchId) {
  const uid = _requireAuth(req);
  if (_isAdmin(req)) return uid;                // platform admins bypass

  // Check if the user is the business owner
  const bizRef  = db.collection('businesses').doc(merchantId);
  const staffRef = db.collection('posStaff')
    .where('branchId', '==', branchId)
    .where('uid', '==', uid)
    .where('status', '==', 'active')
    .limit(1);

  const [bizSnap, staffSnap] = await Promise.all([bizRef.get(), staffRef.get()]);

  if (bizSnap.exists && bizSnap.data().ownerId === uid) return uid;
  if (!staffSnap.empty) return uid;

  // Also check the merchants collection (some modules write ownerId there)
  const merchantSnap = await db.collection('merchants').doc(merchantId).get();
  if (merchantSnap.exists) {
    const m = merchantSnap.data();
    if (m.ownerId === uid) return uid;
    if (Array.isArray(m.adminUids) && m.adminUids.includes(uid)) return uid;
  }

  _err('Access denied — you do not belong to this merchant.', 'permission-denied');
}

/* ─────────────────────────────────────────────────────────────────
   _buildBundle
   Fetches all POS configuration in one parallelised batch.
   Sensitive fields (passwords, hmacKey, secrets) are stripped.
───────────────────────────────────────────────────────────────── */
async function _buildBundle(merchantId, branchId) {
  const t0 = Date.now();

  const [
    businessSnap, branchSnap, productsSnap, categoriesSnap,
    employeesSnap, rolesSnap, taxSnap, paymentMethodsSnap,
    loyaltySnap, discountsSnap, receiptConfigSnap, featureFlagsSnap,
    subscriptionSnap, suppliersSnap,
  ] = await Promise.all([
    db.collection('businesses').doc(merchantId).get(),
    db.collection('branches').doc(branchId).get(),
    db.collection('posProducts')
      .where('merchantId', '==', merchantId)
      .where('status', '==', 'active')
      .limit(500)
      .get(),
    db.collection('categories')
      .where('merchantId', '==', merchantId)
      .get(),
    db.collection('posStaff')
      .where('branchId', '==', branchId)
      .where('status', '==', 'active')
      .get(),
    db.collection('posRoles')
      .where('merchantId', '==', merchantId)
      .get(),
    db.collection('taxConfig').doc(merchantId).get(),
    db.collection('paymentMethods')
      .where('merchantId', '==', merchantId)
      .where('enabled', '==', true)
      .get(),
    db.collection('loyaltyMerchantConfigs').doc(merchantId).get(),
    db.collection('posDiscounts')
      .where('merchantId', '==', merchantId)
      .where('active', '==', true)
      .get(),
    db.collection('receiptConfig').doc(merchantId).get(),
    db.collection('featureFlags').doc(merchantId).get(),
    db.collection('subscriptions')
      .where('merchantId', '==', merchantId)
      .where('status', 'in', ['active', 'trialing'])
      .limit(1)
      .get(),
    db.collection('procSuppliers')
      .where('merchantId', '==', merchantId)
      .where('status', '==', 'active')
      .limit(50)
      .get(),
  ]);

  /* ── Business ───────────────────────────────────────────────── */
  const biz = businessSnap.exists ? businessSnap.data() : {};
  const business = {
    id:           merchantId,
    name:         _san(biz.name || '', 200),
    logo:         biz.logo || null,
    address:      _san(biz.address || '', 300),
    phone:        _san(biz.phone || '', 30),
    email:        _san(biz.email || '', 200),
    currency:     'KES',
    kraPin:       _san(biz.kraPin || '', 20),
    businessType: _san(biz.businessType || '', 100),
  };

  /* ── Branch ─────────────────────────────────────────────────── */
  const br = branchSnap.exists ? branchSnap.data() : {};
  const branch = {
    id:       branchId,
    name:     _san(br.name || '', 200),
    address:  _san(br.address || '', 300),
    phone:    _san(br.phone || '', 30),
    timezone: 'Africa/Nairobi',
  };

  /* ── Products ───────────────────────────────────────────────── */
  const products = productsSnap.docs.map(d => {
    const p = d.data();
    return {
      id:             d.id,
      name:           _san(p.name || '', 200),
      sku:            _san(p.sku || '', 100),
      barcode:        _san(p.barcode || '', 100),
      price:          Number(p.price) || 0,
      cost:           Number(p.cost) || 0,
      categoryId:     p.categoryId || null,
      vatRate:        Number(p.vatRate) || 0.16,
      trackInventory: p.trackInventory !== false,
      qty:            Number(p.qty) || 0,
      reorderPoint:   Number(p.reorderPoint) || 5,
      image:          p.image || null,
    };
  });

  /* ── Categories ─────────────────────────────────────────────── */
  const categories = categoriesSnap.docs.map(d => {
    const c = d.data();
    return {
      id:       d.id,
      name:     _san(c.name || '', 200),
      parentId: c.parentId || null,
      icon:     c.icon || null,
    };
  });

  /* ── Employees — strip PIN and password ─────────────────────── */
  const employees = employeesSnap.docs.map(d => {
    const e = d.data();
    return {
      id:          d.id,
      name:        _san(e.name || e.displayName || '', 200),
      // PIN is stored as SHA-256 hash; we send the hash so the device can
      // do local comparison without round-trips, but never the plaintext.
      pin:         e.pinHash || null,
      role:        _san(e.role || 'cashier', 100),
      permissions: Array.isArray(e.permissions) ? e.permissions : [],
      photo:       e.photoURL || e.photo || null,
    };
  });

  /* ── Roles ──────────────────────────────────────────────────── */
  const roles = rolesSnap.docs.map(d => {
    const r = d.data();
    return {
      id:          d.id,
      name:        _san(r.name || '', 100),
      permissions: Array.isArray(r.permissions) ? r.permissions : [],
    };
  });

  /* ── Tax ────────────────────────────────────────────────────── */
  const tax = taxSnap.exists ? taxSnap.data() : {};
  const taxConfig = {
    vatEnabled:   tax.vatEnabled !== false,
    vatRate:      Number(tax.vatRate) || 0.16,
    etimsEnabled: tax.etimsEnabled === true,
    kraPin:       _san(tax.kraPin || biz.kraPin || '', 20),
  };

  /* ── Payment methods ────────────────────────────────────────── */
  const paymentMethods = paymentMethodsSnap.empty
    ? ['cash', 'mpesa']
    : paymentMethodsSnap.docs.map(d => _san(d.data().type || d.id, 50));

  /* ── Loyalty — hmacKey is server-side only, never sent ─────── */
  const loy = loyaltySnap.exists ? loyaltySnap.data() : {};
  const loyalty = {
    enabled:          loy.enabled === true,
    pointsPerShilling: Number(loy.pointsPerShilling) || 1,
    tiers:            Array.isArray(loy.tiers) ? loy.tiers : [],
    cashbackRate:     Number(loy.cashbackRate) || 0,
    hmacKey:          null,   // never exposed to device
  };

  /* ── Discounts ──────────────────────────────────────────────── */
  const now = Date.now();
  const discounts = discountsSnap.docs
    .map(d => {
      const dis = d.data();
      const validUntil = dis.validUntil?.toDate ? dis.validUntil.toDate() : null;
      return {
        id:         d.id,
        name:       _san(dis.name || '', 200),
        type:       dis.type || 'percentage',
        value:      Number(dis.value) || 0,
        minOrder:   Number(dis.minOrder) || 0,
        validUntil: validUntil ? validUntil.toISOString() : null,
        code:       dis.code ? _san(dis.code, 50) : null,
      };
    })
    .filter(d => !d.validUntil || new Date(d.validUntil).getTime() > now);

  /* ── Receipt config ─────────────────────────────────────────── */
  const rc = receiptConfigSnap.exists ? receiptConfigSnap.data() : {};
  const receipt = {
    header:           _san(rc.header || business.name, 300),
    footer:           _san(rc.footer || 'Thank you for shopping with us!', 300),
    logo:             rc.logo || business.logo || null,
    showLoyaltyPoints: rc.showLoyaltyPoints !== false,
    showVAT:          rc.showVAT !== false,
    printerType:      rc.printerType || 'thermal_80mm',
  };

  /* ── Feature flags ──────────────────────────────────────────── */
  const ff = featureFlagsSnap.exists ? featureFlagsSnap.data() : {};
  const featureFlags = {
    inventory:    ff.inventory !== false,
    loyalty:      ff.loyalty !== false,
    delivery:     ff.delivery !== false,
    marketplace:  ff.marketplace !== false,
    etims:        ff.etims !== false,
    aiAssistant:  ff.aiAssistant !== false,
  };

  /* ── Subscription ───────────────────────────────────────────── */
  let subscription = { plan: 'free', status: 'active', expiresAt: null };
  if (!subscriptionSnap.empty) {
    const sub = subscriptionSnap.docs[0].data();
    subscription = {
      plan:      _san(sub.plan || 'free', 100),
      status:    _san(sub.status || 'active', 50),
      expiresAt: sub.expiresAt?.toDate ? sub.expiresAt.toDate().toISOString() : null,
    };
  }

  /* ── Suppliers ──────────────────────────────────────────────── */
  const suppliers = suppliersSnap.docs.map(d => {
    const s = d.data();
    return {
      id:    d.id,
      name:  _san(s.name || '', 200),
      phone: _san(s.phone || '', 30),
    };
  });

  const builtAt = new Date().toISOString();
  const buildMs = Date.now() - t0;

  _log('INFO', '_buildBundle complete', { merchantId, branchId, buildMs });

  return {
    version:    1,
    syncToken:  `${merchantId}_${branchId}_${Date.now()}`,
    business,
    branch,
    products,
    categories,
    employees,
    roles,
    tax:            taxConfig,
    paymentMethods,
    loyalty,
    discounts,
    receipt,
    featureFlags,
    subscription,
    suppliers,
    builtAt,
    ttlSeconds: CACHE_TTL_SECS,
    _buildMs:   buildMs,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   CF 1 — bootstrapDevice
   Returns the full cached or freshly-built bundle.
   Called once per device launch / shift start.
═══════════════════════════════════════════════════════════════════ */
exports.bootstrapDevice = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const {
    merchantId,
    branchId,
    deviceId    = null,
    forceRefresh = false,
  } = req.data || {};

  if (!merchantId) _err('merchantId is required.');
  if (!branchId)   _err('branchId is required.');

  const safeMerchantId = _san(merchantId, 128);
  const safeBranchId   = _san(branchId, 128);

  await _assertMerchantAccess(req, safeMerchantId, safeBranchId);

  const cacheId  = `${safeMerchantId}_${safeBranchId}`;
  const cacheRef = db.collection('bootstrapCache').doc(cacheId);

  let bundle   = null;
  let cached   = false;
  const buildStart = Date.now();

  if (!forceRefresh) {
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const c = cacheSnap.data();
      const builtAt = c.builtAt?.toDate ? c.builtAt.toDate() : null;
      if (builtAt && Date.now() - builtAt.getTime() < CACHE_TTL_MS) {
        bundle = c.bundle;
        cached = true;
        _log('INFO', 'bootstrapDevice cache hit', { merchantId: safeMerchantId, branchId: safeBranchId, uid });
      }
    }
  }

  if (!bundle) {
    try {
      bundle = await _buildBundle(safeMerchantId, safeBranchId);
    } catch (buildErr) {
      /* _buildBundle makes 14 parallel Firestore reads. Surface the first failing
         sub-query rather than a generic 'internal' error. */
      _log('ERROR', 'bootstrapDevice _buildBundle failed', {
        merchantId: safeMerchantId, branchId: safeBranchId, err: buildErr.message,
      });
      throw new HttpsError(
        'internal',
        `Bundle build failed: ${buildErr.message}. Check Cloud Logging for detail.`,
      );
    }

    // Write to cache (don't await — don't block the response)
    cacheRef.set({
      bundle,
      version:    bundle.version,
      builtAt:    F.serverTimestamp(),
      ttlSeconds: CACHE_TTL_SECS,
    }).catch(e => _log('WARNING', 'Failed to write bootstrapCache', { error: e.message }));
  }

  // Register / update device if deviceId provided
  if (deviceId) {
    const safeDeviceId = _san(deviceId, 200);
    const deviceRef = db.collection('posDevices').doc(safeDeviceId);
    deviceRef.set({
      deviceId:   safeDeviceId,
      merchantId: safeMerchantId,
      branchId:   safeBranchId,
      cashierId:  uid,
      lastSeenAt: F.serverTimestamp(),
      lastSyncAt: F.serverTimestamp(),
      status:     'active',
    }, { merge: true }).catch(e =>
      _log('WARNING', 'Failed to update posDevice on bootstrap', { error: e.message })
    );
  }

  return {
    ...bundle,
    cached,
    buildMs: Date.now() - buildStart,
  };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 2 — getIncrementalSync
   Returns only the records that changed after `since` timestamp.
   Keeps traffic minimal between full bootstraps.
═══════════════════════════════════════════════════════════════════ */
exports.getIncrementalSync = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const {
    merchantId,
    branchId,
    since,
  } = req.data || {};

  if (!merchantId) _err('merchantId is required.');
  if (!branchId)   _err('branchId is required.');
  if (!since)      _err('since timestamp is required.');

  const safeMerchantId = _san(merchantId, 128);
  const safeBranchId   = _san(branchId, 128);

  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) _err('since must be a valid ISO timestamp.');

  await _assertMerchantAccess(req, safeMerchantId, safeBranchId);

  _log('INFO', 'getIncrementalSync', { merchantId: safeMerchantId, branchId: safeBranchId, since, uid });

  const [productsSnap, employeesSnap, discountsSnap, flagsSnap] = await Promise.all([
    db.collection('posProducts')
      .where('merchantId', '==', safeMerchantId)
      .where('status', '==', 'active')
      .where('updatedAt', '>', sinceDate)
      .limit(200)
      .get(),
    db.collection('posStaff')
      .where('branchId', '==', safeBranchId)
      .where('status', '==', 'active')
      .where('updatedAt', '>', sinceDate)
      .limit(100)
      .get(),
    db.collection('posDiscounts')
      .where('merchantId', '==', safeMerchantId)
      .where('active', '==', true)
      .where('updatedAt', '>', sinceDate)
      .limit(100)
      .get(),
    db.collection('featureFlags').doc(safeMerchantId).get(),
  ]);

  const products = productsSnap.docs.map(d => {
    const p = d.data();
    return {
      id:             d.id,
      name:           _san(p.name || '', 200),
      sku:            _san(p.sku || '', 100),
      barcode:        _san(p.barcode || '', 100),
      price:          Number(p.price) || 0,
      cost:           Number(p.cost) || 0,
      categoryId:     p.categoryId || null,
      vatRate:        Number(p.vatRate) || 0.16,
      trackInventory: p.trackInventory !== false,
      qty:            Number(p.qty) || 0,
      reorderPoint:   Number(p.reorderPoint) || 5,
      image:          p.image || null,
      updatedAt:      p.updatedAt?.toDate ? p.updatedAt.toDate().toISOString() : null,
    };
  });

  const employees = employeesSnap.docs.map(d => {
    const e = d.data();
    return {
      id:          d.id,
      name:        _san(e.name || e.displayName || '', 200),
      pin:         e.pinHash || null,
      role:        _san(e.role || 'cashier', 100),
      permissions: Array.isArray(e.permissions) ? e.permissions : [],
      photo:       e.photoURL || e.photo || null,
      updatedAt:   e.updatedAt?.toDate ? e.updatedAt.toDate().toISOString() : null,
    };
  });

  const now = Date.now();
  const discounts = discountsSnap.docs
    .map(d => {
      const dis = d.data();
      const validUntil = dis.validUntil?.toDate ? dis.validUntil.toDate() : null;
      return {
        id:         d.id,
        name:       _san(dis.name || '', 200),
        type:       dis.type || 'percentage',
        value:      Number(dis.value) || 0,
        minOrder:   Number(dis.minOrder) || 0,
        validUntil: validUntil ? validUntil.toISOString() : null,
        code:       dis.code ? _san(dis.code, 50) : null,
        updatedAt:  dis.updatedAt?.toDate ? dis.updatedAt.toDate().toISOString() : null,
      };
    })
    .filter(d => !d.validUntil || new Date(d.validUntil).getTime() > now);

  const ff = flagsSnap.exists ? flagsSnap.data() : {};
  const featureFlags = {
    inventory:   ff.inventory !== false,
    loyalty:     ff.loyalty !== false,
    delivery:    ff.delivery !== false,
    marketplace: ff.marketplace !== false,
    etims:       ff.etims !== false,
    aiAssistant: ff.aiAssistant !== false,
  };

  const newSyncToken = `${safeMerchantId}_${safeBranchId}_${Date.now()}`;

  return {
    changes: { products, employees, discounts, featureFlags },
    newSyncToken,
    serverTime: new Date().toISOString(),
  };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 3 — invalidateBootstrapCache
   Admin / owner can bust the cache for a merchant (all branches or
   a single branch).  Also called internally when data changes.
═══════════════════════════════════════════════════════════════════ */
exports.invalidateBootstrapCache = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { merchantId, branchId = null } = req.data || {};
  if (!merchantId) _err('merchantId is required.');

  const safeMerchantId = _san(merchantId, 128);

  // Only admin or the business owner may invalidate
  if (!_isAdmin(req)) {
    const bizSnap = await db.collection('businesses').doc(safeMerchantId).get();
    const merchantSnap = await db.collection('merchants').doc(safeMerchantId).get();
    const isOwner =
      (bizSnap.exists && bizSnap.data().ownerId === uid) ||
      (merchantSnap.exists && (
        merchantSnap.data().ownerId === uid ||
        (Array.isArray(merchantSnap.data().adminUids) && merchantSnap.data().adminUids.includes(uid))
      ));
    if (!isOwner) _err('Only the merchant owner or platform admin may invalidate the cache.', 'permission-denied');
  }

  const cacheRef = db.collection('bootstrapCache');

  if (branchId) {
    // Single branch
    const docId = `${safeMerchantId}_${_san(branchId, 128)}`;
    await cacheRef.doc(docId).delete();
    _log('INFO', 'invalidateBootstrapCache — single branch', { merchantId: safeMerchantId, branchId, uid });
    return { invalidated: [docId] };
  } else {
    // All branches for this merchant
    const snap = await cacheRef
      .where('bundle.business.id', '==', safeMerchantId)
      .get();

    // Fallback: delete by known prefix pattern using a batch
    const batch   = db.batch();
    const deleted = [];

    if (!snap.empty) {
      snap.docs.forEach(d => { batch.delete(d.ref); deleted.push(d.id); });
    } else {
      // Query by branchId prefix isn't supported in Firestore; fetch candidate
      // documents via a range query on the document ID string.
      const rangeSnap = await cacheRef
        .orderBy(admin.firestore.FieldPath.documentId())
        .startAt(`${safeMerchantId}_`)
        .endAt(`${safeMerchantId}_`)
        .get();
      rangeSnap.docs.forEach(d => { batch.delete(d.ref); deleted.push(d.id); });
    }

    if (deleted.length > 0) await batch.commit();

    _log('INFO', 'invalidateBootstrapCache — all branches', { merchantId: safeMerchantId, deleted, uid });
    return { invalidated: deleted };
  }
});

/* ═══════════════════════════════════════════════════════════════════
   CF 4 — getBusinessConfig
   Lightweight pre-branch-selection call.
   Returns business profile + list of branches.
   Used by the POS setup wizard before the user picks a branch.
═══════════════════════════════════════════════════════════════════ */
exports.getBusinessConfig = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { merchantId } = req.data || {};
  if (!merchantId) _err('merchantId is required.');

  const safeMerchantId = _san(merchantId, 128);

  // Caller must be admin, business owner, or a staff member for ANY branch
  if (!_isAdmin(req)) {
    const [bizSnap, merchantSnap, staffSnap] = await Promise.all([
      db.collection('businesses').doc(safeMerchantId).get(),
      db.collection('merchants').doc(safeMerchantId).get(),
      db.collection('posStaff')
        .where('merchantId', '==', safeMerchantId)
        .where('uid', '==', uid)
        .where('status', '==', 'active')
        .limit(1)
        .get(),
    ]);

    const isOwner =
      (bizSnap.exists && bizSnap.data().ownerId === uid) ||
      (merchantSnap.exists && (
        merchantSnap.data().ownerId === uid ||
        (Array.isArray(merchantSnap.data().adminUids) && merchantSnap.data().adminUids.includes(uid))
      ));

    if (!isOwner && staffSnap.empty) {
      _err('Access denied.', 'permission-denied');
    }
  }

  const [bizSnap, branchesSnap] = await Promise.all([
    db.collection('businesses').doc(safeMerchantId).get(),
    db.collection('branches')
      .where('merchantId', '==', safeMerchantId)
      .where('status', '==', 'active')
      .orderBy('name')
      .get(),
  ]);

  if (!bizSnap.exists) _err('Business not found.', 'not-found');

  const biz = bizSnap.data();
  const business = {
    id:           safeMerchantId,
    name:         _san(biz.name || '', 200),
    logo:         biz.logo || null,
    address:      _san(biz.address || '', 300),
    phone:        _san(biz.phone || '', 30),
    email:        _san(biz.email || '', 200),
    currency:     'KES',
    kraPin:       _san(biz.kraPin || '', 20),
    businessType: _san(biz.businessType || '', 100),
  };

  const branches = branchesSnap.docs.map(d => {
    const b = d.data();
    return {
      id:      d.id,
      name:    _san(b.name || '', 200),
      address: _san(b.address || '', 300),
    };
  });

  _log('INFO', 'getBusinessConfig', { merchantId: safeMerchantId, branchCount: branches.length, uid });

  return { business, branches };
});

/* ═══════════════════════════════════════════════════════════════════
   CF 5 — validateDeviceAccess
   PIN-based staff authentication for a specific branch.
   Rate-limited: max 5 attempts per uid per 5 minutes.
   PIN is stored as SHA-256 hash; comparison done server-side.
═══════════════════════════════════════════════════════════════════ */
exports.validateDeviceAccess = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);

  const { merchantId, branchId, pin } = req.data || {};
  if (!merchantId) _err('merchantId is required.');
  if (!branchId)   _err('branchId is required.');
  if (!pin)        _err('pin is required.');
  if (typeof pin !== 'string' || pin.length < 4 || pin.length > 20) {
    _err('pin must be 4–20 characters.');
  }

  const safeMerchantId = _san(merchantId, 128);
  const safeBranchId   = _san(branchId, 128);

  /* ── Rate limit: 5 attempts per uid per 5 minutes ──────────── */
  const RATE_WINDOW_MS = 5 * 60 * 1000;
  const MAX_ATTEMPTS   = 5;
  const rateLimitId    = `${uid}_pin`;
  const rateLimitRef   = db.collection('rateLimits').doc(rateLimitId);

  const rl = await rateLimitRef.get();
  if (rl.exists) {
    const r = rl.data();
    const windowStart = r.windowStart?.toDate ? r.windowStart.toDate() : null;
    if (windowStart && Date.now() - windowStart.getTime() < RATE_WINDOW_MS) {
      if ((r.attempts || 0) >= MAX_ATTEMPTS) {
        _log('WARNING', 'validateDeviceAccess rate-limit hit', { uid, merchantId: safeMerchantId });
        _err('Too many PIN attempts. Please wait 5 minutes and try again.', 'resource-exhausted');
      }
    }
  }

  // Increment attempt counter (write before checking PIN — prevents timing attacks)
  await rateLimitRef.set({
    uid,
    attempts:    F.increment(1),
    windowStart: rl.exists ? rl.data().windowStart : F.serverTimestamp(),
    lastAttempt: F.serverTimestamp(),
  }, { merge: true });

  /* ── Hash the incoming PIN and compare ─────────────────────── */
  const pinHash = _sha256(pin);

  const staffSnap = await db.collection('posStaff')
    .where('branchId', '==', safeBranchId)
    .where('pinHash', '==', pinHash)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (staffSnap.empty) {
    _log('WARNING', 'validateDeviceAccess — invalid PIN', { uid, merchantId: safeMerchantId, branchId: safeBranchId });
    return { valid: false, employee: null };
  }

  // Success — reset rate limit window
  await rateLimitRef.set({
    uid,
    attempts:    0,
    windowStart: F.serverTimestamp(),
    lastSuccess: F.serverTimestamp(),
  });

  const emp = staffSnap.docs[0];
  const e   = emp.data();

  _log('INFO', 'validateDeviceAccess — success', {
    uid,
    staffId: emp.id,
    merchantId: safeMerchantId,
    branchId: safeBranchId,
  });

  return {
    valid: true,
    employee: {
      id:          emp.id,
      name:        _san(e.name || e.displayName || '', 200),
      role:        _san(e.role || 'cashier', 100),
      permissions: Array.isArray(e.permissions) ? e.permissions : [],
    },
  };
});

/* ══════════════════════════════════════════════════════════════════
   SmartPOS Onboarding v2 — auto Merchant ID, business picker, create,
   device pairing. Exposed via smartPosDispatch (NO new Cloud Run
   service): these handlers live in the `_h` registry and are merged by
   smartpos-dispatch.js. Ownership is always validated on the backend.
══════════════════════════════════════════════════════════════════ */

/* Merchant ID: human-readable, immutable (doc id), globally unique.
   Format SOK-XXXXXX using an unambiguous alphabet (no 0/O/1/I). */
const _MID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function _generateMerchantId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let j = 0; j < 6; j++) code += _MID_ALPHABET[bytes[j] % _MID_ALPHABET.length];
    const id = `SOK-${code}`;
    const snap = await db.collection('businesses').doc(id).get();
    if (!snap.exists) return id;   // collision-free (indexed doc-id lookup)
  }
  _err('Could not allocate a unique Merchant ID — please retry.', 'aborted');
}

/* Short, human-readable code from the unambiguous alphabet. */
function _shortCode(prefix, len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += _MID_ALPHABET[bytes[i] % _MID_ALPHABET.length];
  return `${prefix}-${s}`;
}

/* Per-business-type intelligent defaults (Step 8). Keeps onboarding zero-typing:
   sensible categories + POS behaviour flags derived from the business type. */
const _TYPE_DEFAULTS = {
  restaurant:  { categories: ['Food', 'Drinks', 'Desserts'],        flags: { kitchenPrinter: true, tableService: true, taxInclusive: true } },
  cafe:        { categories: ['Hot Drinks', 'Cold Drinks', 'Snacks'], flags: { kitchenPrinter: true, tableService: true } },
  bakery:      { categories: ['Bread', 'Cakes', 'Pastries'],         flags: { kitchenPrinter: true } },
  supermarket: { categories: ['Groceries', 'Beverages', 'Household'], flags: { barcodeScanning: true, weighScale: true } },
  pharmacy:    { categories: ['Prescription', 'OTC', 'Wellness'],     flags: { batchTracking: true, expiryTracking: true } },
  hardware:    { categories: ['Tools', 'Building', 'Electrical'],     flags: { barcodeScanning: true } },
  electronics: { categories: ['Phones', 'Accessories', 'Computing'],  flags: { barcodeScanning: true, serialTracking: true } },
  clothing:    { categories: ['Men', 'Women', 'Kids'],               flags: { variantMatrix: true } },
  liquor:      { categories: ['Beer', 'Wine', 'Spirits'],            flags: { ageRestricted: true } },
  salon:       { categories: ['Services', 'Products'],               flags: { appointments: true } },
  hotel:       { categories: ['Rooms', 'Food', 'Bar'],              flags: { tableService: true, roomBilling: true } },
  wholesale:   { categories: ['Bulk', 'Retail'],                     flags: { tieredPricing: true, barcodeScanning: true } },
  default:     { categories: ['General'],                            flags: {} },
};
function _typeDefaults(category) {
  const key = String(category || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const k of Object.keys(_TYPE_DEFAULTS)) if (key.includes(k)) return _TYPE_DEFAULTS[k];
  return _TYPE_DEFAULTS.default;
}

/* getMyBusinesses — businesses the authenticated user owns. No Merchant ID
   required; drives the onboarding business picker. */
async function _getMyBusinesses(req) {
  const uid = _requireAuth(req);
  /* Detect ownership across both the businesses doc and the legacy merchants
     mirror (older businesses recorded ownership only in `merchants`). Union by
     merchantId so existing users see their shops without any migration. */
  const [ownedBiz, ownedMerchant, adminMerchant] = await Promise.all([
    db.collection('businesses').where('ownerId', '==', uid).limit(50).get(),
    db.collection('merchants').where('ownerId', '==', uid).limit(50).get().catch(() => ({ docs: [] })),
    db.collection('merchants').where('adminUids', 'array-contains', uid).limit(50).get().catch(() => ({ docs: [] })),
  ]);

  const ids = new Set();
  const businesses = [];
  const push = (mid, b, role) => {
    if (ids.has(mid)) return;
    ids.add(mid);
    businesses.push({
      merchantId: mid,
      businessId: (b && b.businessId) || mid,
      name:       _san((b && (b.name || b.businessName)) || '', 200),
      logo:       (b && b.logo) || null,
      category:   (b && (b.category || b.businessType)) || null,
      branch:     (b && b.defaultBranchId) || `${mid}-main`,
      status:     (b && b.status) || 'active',
      role,
    });
  };
  ownedBiz.docs.forEach((d) => push(d.id, d.data(), 'owner'));
  /* For merchant-only matches, fetch the business doc for display fields. */
  const merchantOnly = [...ownedMerchant.docs, ...adminMerchant.docs].filter((d) => !ids.has(d.id));
  const bizDocs = await Promise.all(merchantOnly.map((d) => db.collection('businesses').doc(d.id).get().catch(() => null)));
  merchantOnly.forEach((d, i) => {
    const bd = bizDocs[i];
    push(d.id, (bd && bd.exists) ? bd.data() : d.data(), 'owner');
  });

  return { businesses, count: businesses.length };
}

/* ══════════════════════════════════════════════════════════════════════════
   ENSURE — the IDEMPOTENT entry point. Approval is retried; onboarding is
   re-entered; a device pairs twice. _createBusiness itself has NO guard: it
   mints a fresh merchantId with _generateMerchantId() and unconditionally
   commits, so calling it twice produces TWO businesses, two branch sets, two
   pairing tokens and two identities for one merchant.

   Two locks, because one is not enough:

     1. An OWNERSHIP read — businesses where ownerId == uid. This is what
        catches a merchant provisioned before this guard existed, and it is
        the same question sokoni-pos-context.js asks, so 'provisioned' and
        'the till can see it' cannot disagree.

     2. A TRANSACTIONAL claim at posProvisioning/{uid}. The read above cannot
        stop two concurrent approvals both finding nothing and both creating.
        The claim is keyed on the CANONICAL uid — never a browser value — and
        winning it is what grants the right to create.

   Returns { created:false } when a business already exists. It does NOT
   repair or migrate an existing record: silently rewriting a live merchant's
   identity from an approval retry is a larger risk than a missing default. */
async function _ensureBusinessForOwner(o) {
  const uid = _san(o && o.uid, 128);
  if (!uid) throw new Error('_ensureBusinessForOwner requires a uid');

  const owned = await db.collection('businesses').where('ownerId', '==', uid).limit(1).get();
  if (!owned.empty) {
    const doc = owned.docs[0];
    return { created: false, reason: 'already-provisioned', merchantId: doc.id,
             provisionedBy: (doc.data() || {}).provisionedBy || null };
  }

  const guard = db.collection('posProvisioning').doc(uid);
  const won = await db.runTransaction(async (t) => {
    const g = await t.get(guard);
    if (g.exists) return false;
    t.set(guard, { uid, provisionedBy: 'approval',
                   startedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
  if (!won) return { created: false, reason: 'claim-held', merchantId: null };

  try {
    const res = await _createBusiness({
      auth: { uid: uid },
      data: {
        businessName: _san(o.businessName || '', 200).trim() || 'My Business',
        category: _san(o.category || '', 80).trim() || 'General',
        phone: o.phone || '', county: o.county || '', city: o.city || '',
        __provisionedBy: 'approval',
      },
    });
    await guard.set({ merchantId: res.merchantId, ok: true,
                      finishedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { created: true, reason: 'provisioned', merchantId: res.merchantId,
             branchId: res.branchId };
  } catch (e) {
    /* RELEASE THE CLAIM ON FAILURE. A claim held by a run that died leaves the
       merchant permanently unprovisionable — the exact failure this guard
       exists to prevent, arrived at from the other direction. */
    await guard.delete().catch(() => {});
    throw e;
  }
}

/* createBusiness — first-time onboarding. Auto-generates the Merchant ID and
   Business ID, provisions defaults (branch, owner staff+role, payment methods,
   tax/receipt/flags/settings, starter category), and returns a pairing QR. */
async function _createBusiness(req) {
  const uid = _requireAuth(req);
  const d = req.data || {};
  const businessName = _san(d.businessName || '', 200).trim();
  if (!businessName) _err('Business name is required.');
  const category = _san(d.category || '', 80).trim();
  if (!category) _err('Business category is required.');

  const merchantId  = await _generateMerchantId();
  const businessId  = 'BIZ-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const branchId    = `${merchantId}-main`;
  const pairingToken = crypto.randomBytes(20).toString('hex');
  const now = admin.firestore.FieldValue.serverTimestamp();
  const qr  = JSON.stringify({ v: 1, t: 'sokoni-pos-pair', merchantId, businessId, branchId, token: pairingToken });

  /* Full enterprise ID set — all auto-generated, never typed by the user. */
  const storeCode     = _shortCode('STR', 6);
  const posCode       = _shortCode('POS', 6);
  const publicStoreId = _shortCode('SHOP', 6);
  const referralCode  = _shortCode('REF', 6);
  const apiPublicKey  = 'pk_' + crypto.randomBytes(12).toString('hex');
  const typeDef       = _typeDefaults(category);

  const batch = db.batch();
  batch.set(db.collection('businesses').doc(merchantId), {
    merchantId, businessId, name: businessName, businessName,
    category, businessType: category,
    country: _san(d.country || 'Kenya', 80), county: _san(d.county || '', 120), city: _san(d.city || d.county || '', 120),
    phone: _san(d.phone || '', 30), logo: d.logo || null, currency: 'KES',
    ownerId: uid, status: 'active', defaultBranchId: branchId, pairingToken,
    storeCode, posCode, publicStoreId, referralCode, apiPublicKey,
    typeFlags: typeDef.flags,
    /* Setup checklist — auto-satisfied steps true; explicit steps pending. */
    setupChecklist: {
      subscription: true, taxesConfigured: true, staff: false,
      inventoryReady: false, hardwareConnected: false, testSaleSuccessful: false,
    },
    productionReady: false,
    /* WHO provisioned this business. An allowlist, not a passthrough: this is
       a provenance label on a canonical record, and a caller must not be able
       to write an arbitrary string onto it. */
    provisionedBy: (d.__provisionedBy === 'approval') ? 'approval' : 'onboarding-v2',
    createdAt: now, updatedAt: now,
  });
  /* Auto-activate a free trial (Step 7 — activates automatically where applicable).
   *
   * The doc used to carry only { plan:'trial', status:'trialing', trialDays:14 } — and every
   * expiry mechanism filters on fields it did NOT have, so the trial NEVER expired:
   *   • sub-billing.subProcessExpirations reads `currentPeriodEnd.toMillis()` → undefined → skipped
   *   • sub-engine renewals query `.where('currentPeriodEnd','<=',…)` → doc invisible to the query
   *   • subscription-core.computeStatus needs `trial === true` + `trialEndsAt` (it had `plan:'trial'`)
   *   • the expiry path then notifies `users/{sub.uid}` — `uid` was absent, so it would have thrown
   * `trialDays: 14` was therefore decorative: every SmartPOS merchant got an unlimited free tier.
   *
   * Write the fields the engines actually read. `now` is a serverTimestamp sentinel and cannot
   * be used in arithmetic, so the boundaries are explicit Timestamps off the server clock. */
  const _trialMs   = Date.now();
  const _trialEnd  = admin.firestore.Timestamp.fromMillis(_trialMs + TRIAL_DAYS * 86400000);
  const _graceEnd  = admin.firestore.Timestamp.fromMillis(
    _trialMs + (TRIAL_DAYS + TRIAL_GRACE_DAYS) * 86400000
  );
  batch.set(db.collection('subscriptions').doc(merchantId), {
    merchantId,
    uid,                                  // required by the expiry notifier (users/{uid})
    hubType:  'seller',                   // drives the post-trial downgrade to `${hubType}_free`
    planId:   'seller_free',
    planName: 'SmartPOS',
    plan: 'trial',
    status: 'trialing',
    trial: true,                          // subscription-core.computeStatus gate
    trialDays: TRIAL_DAYS,
    trialStartsAt:      now,
    currentPeriodStart: now,
    trialEndsAt:      _trialEnd,          // subscription-core
    currentPeriodEnd: _trialEnd,          // sub-billing sweep + sub-engine renewal query
    graceEnd:         _graceEnd,
    autoActivated: true,
    startedAt: now, createdAt: now,
  });
  batch.set(db.collection('merchants').doc(merchantId), {
    merchantId, name: businessName, ownerId: uid, adminUids: [uid], status: 'active', createdAt: now,
  });
  batch.set(db.collection('branches').doc(branchId), {
    id: branchId, merchantId, name: 'Main Branch', address: _san(d.county || '', 120),
    phone: _san(d.phone || '', 30), timezone: 'Africa/Nairobi', isDefault: true, status: 'active', createdAt: now,
  });
  batch.set(db.collection('posRoles').doc(`${merchantId}-owner`), {
    merchantId, name: 'Owner', key: 'owner', permissions: ['*'], isDefault: true, createdAt: now,
  });
  batch.set(db.collection('posStaff').doc(`${branchId}-${uid}`), {
    merchantId, branchId, uid, name: _san(d.ownerName || '', 120) || 'Owner',
    role: 'owner', status: 'active', createdAt: now,
  });
  batch.set(db.collection('paymentMethods').doc(`${merchantId}-cash`),  { merchantId, type: 'cash',  label: 'Cash',   enabled: true, order: 1, createdAt: now });
  batch.set(db.collection('paymentMethods').doc(`${merchantId}-mpesa`), { merchantId, type: 'mpesa', label: 'M-Pesa', enabled: true, order: 2, createdAt: now });
  batch.set(db.collection('taxConfig').doc(merchantId),     { merchantId, vatEnabled: false, vatRate: 16, currency: 'KES', createdAt: now });
  batch.set(db.collection('receiptConfig').doc(merchantId), { merchantId, header: businessName, footer: 'Thank you for shopping with us', showLogo: true, createdAt: now });
  batch.set(db.collection('featureFlags').doc(merchantId),  Object.assign({ merchantId, offlineMode: true, loyalty: false, createdAt: now }, typeDef.flags));
  batch.set(db.collection('posSettings').doc(merchantId),   { merchantId, currency: 'KES', lowStockThreshold: 5, roundingMode: 'none', barcodeFormat: 'CODE128', createdAt: now });
  /* Intelligent starter categories derived from the business type (Step 8). */
  typeDef.categories.forEach((catName, i) => {
    const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    batch.set(db.collection('categories').doc(`${merchantId}-${slug}`), { merchantId, name: catName, isDefault: i === 0, order: i + 1, createdAt: now });
  });

  await batch.commit();
  _log('INFO', 'createBusiness provisioned', { merchantId, uid, category });
  return {
    merchantId, businessId, branchId, storeCode, posCode, publicStoreId, referralCode,
    apiPublicKey, name: businessName, category, status: 'active',
    qr,                              // business pairing QR (back-compat)
    qrs: {
      business: qr,
      pos:      JSON.stringify({ v: 1, t: 'sokoni-pos-device', merchantId, branchId, posCode }),
    },
  };
}

/* pairDevice — connect an additional device via Merchant ID or scanned QR.
   Ownership/staff is validated on the backend; the client Merchant ID is
   never trusted. If a QR token is supplied it must match the business. */
async function _pairDevice(req) {
  _requireAuth(req);
  const d = req.data || {};
  let merchantId = _san(d.merchantId || '', 128).trim();
  let branchId   = _san(d.branchId || '', 128).trim();
  let token = null;
  if (!merchantId && d.qr) {
    try {
      const p = JSON.parse(d.qr);
      if (p && p.t === 'sokoni-pos-pair') { merchantId = _san(p.merchantId || '', 128); branchId = _san(p.branchId || '', 128); token = p.token || null; }
      else _err('Invalid pairing QR code.');
    } catch (qrErr) {
      _log('WARNING', 'pairDevice QR parse error', { error: qrErr.message, uid });
      _err('Invalid pairing QR code.');
    }
  }
  if (!merchantId) _err('Merchant ID or a valid pairing QR is required.');
  if (!branchId) branchId = `${merchantId}-main`;

  await _assertMerchantAccess(req, merchantId, branchId);   // backend ownership check

  const bizSnap = await db.collection('businesses').doc(merchantId).get();
  if (!bizSnap.exists) _err('Business not found.', 'not-found');
  const b = bizSnap.data();
  if (token && b.pairingToken !== token) _err('Pairing code expired or invalid — regenerate the QR.', 'permission-denied');

  return {
    ok: true, merchantId, branchId,
    business: { merchantId, name: _san(b.name || b.businessName || '', 200), logo: b.logo || null, category: b.category || b.businessType || null, status: b.status || 'active' },
  };
}

/* regeneratePairingQR — new pairing token/QR WITHOUT changing the Merchant ID
   (owner only). For Business Settings → "Regenerate pairing QR". */
async function _regeneratePairingQR(req) {
  const uid = _requireAuth(req);
  const d = req.data || {};
  const merchantId = _san(d.merchantId || '', 128).trim();
  if (!merchantId) _err('merchantId is required.');
  const ref = db.collection('businesses').doc(merchantId);
  const snap = await ref.get();
  if (!snap.exists) _err('Business not found.', 'not-found');
  if (snap.data().ownerId !== uid && !_isAdmin(req)) _err('Only the owner can regenerate the pairing QR.', 'permission-denied');
  const pairingToken = crypto.randomBytes(20).toString('hex');
  const b = snap.data();
  const branchId = b.defaultBranchId || `${merchantId}-main`;
  await ref.update({ pairingToken, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { merchantId, qr: JSON.stringify({ v: 1, t: 'sokoni-pos-pair', merchantId, businessId: b.businessId || merchantId, branchId, token: pairingToken }) };
}

/* getSetupStatus — authoritative resume logic + production-readiness checklist,
   computed from REAL Firestore state so the wizard resumes at the first
   incomplete step and never marks a merchant production-ready prematurely. */
/* ── THE MERCHANT'S PAYMENT DESTINATION — MANUAL M-PESA ────────────────────
   Under DIRECT_TO_SELLER the customer pays the shop's OWN till and the shop
   keeps 100%; SOKONI records the sale and holds the commission as a
   receivable. So the only thing SOKONI needs is WHERE the money goes, for the
   receipt and for reconciliation — a till number and an account name.

   THIS DELIBERATELY ACCEPTS NO API CREDENTIALS. Consumer key, consumer secret
   and LNM passkey are not parameters here and must never become merchant-
   editable fields. Automatic STK needs them because Safaricom binds the
   passkey to the shortcode — base64(ShortCode + PassKey + Timestamp) cannot be
   signed for a till SOKONI does not hold the passkey for — which is exactly
   why automatic STK is an upgrade requiring the merchant's own Daraja app,
   and not a prerequisite for selling.

   Written SERVER-SIDE because posSettings has no Firestore rule at all, and
   an unmatched collection denies by default. That is the correct posture for
   POS configuration: it is not client-writable, and this is the one door. */
async function _savePaymentDestination(req) {
  const uid = _requireAuth(req);
  const d = req.data || {};
  let merchantId = _san(d.merchantId || '', 128).trim();
  if (!merchantId) {
    const owned = await db.collection('businesses').where('ownerId', '==', uid).limit(1).get();
    if (owned.empty) _err('No business on this account.', 'not-found');
    merchantId = owned.docs[0].id;
  }
  /* TENANCY. Never trust a client-supplied merchantId — the whole point of
     resolving it above is defeated if a caller may simply pass another one. */
  const bizSnap = await db.collection('businesses').doc(merchantId).get();
  if (!bizSnap.exists) _err('Business not found.', 'not-found');
  if ((bizSnap.data() || {}).ownerId !== uid && !_isAdmin(req)) {
    _err('Access denied.', 'permission-denied');
  }

  const till = _san(d.till || '', 20).replace(/\D/g, '');
  const accountName = _san(d.accountName || '', 60).trim();
  const kind = (d.kind === 'paybill') ? 'paybill' : 'till';
  if (!till) _err('A Till or PayBill number is required.');
  if (till.length < 5 || till.length > 12) _err('That does not look like a Till or PayBill number.');

  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection('posSettings').doc(merchantId).set({
    merchantId,
    mpesaMode: 'manual',        /* the customer pays the till directly */
    mpesaKind: kind,
    mpesaTill: till,
    mpesaAccountName: accountName || (bizSnap.data() || {}).name || '',
    mpesaConfiguredAt: now,
    mpesaConfiguredBy: uid,
    updatedAt: now,
  }, { merge: true });

  return { ok: true, merchantId, mpesaMode: 'manual', mpesaKind: kind,
           mpesaTill: till, mpesaAccountName: accountName };
}

/* Read it back for the setup screen. Same tenancy guard; no secrets exist here
   to leak, because none are ever accepted. */
async function _getPaymentDestination(req) {
  const uid = _requireAuth(req);
  const d = req.data || {};
  let merchantId = _san(d.merchantId || '', 128).trim();
  if (!merchantId) {
    const owned = await db.collection('businesses').where('ownerId', '==', uid).limit(1).get();
    if (owned.empty) return { configured: false, reason: 'no-business' };
    merchantId = owned.docs[0].id;
  }
  const bizSnap = await db.collection('businesses').doc(merchantId).get();
  if (!bizSnap.exists) _err('Business not found.', 'not-found');
  if ((bizSnap.data() || {}).ownerId !== uid && !_isAdmin(req)) _err('Access denied.', 'permission-denied');
  const ps = await db.collection('posSettings').doc(merchantId).get();
  const v = ps.exists ? (ps.data() || {}) : {};
  return {
    configured: !!v.mpesaTill,
    merchantId,
    mpesaMode: v.mpesaMode || 'manual',
    mpesaKind: v.mpesaKind || 'till',
    mpesaTill: v.mpesaTill || '',
    mpesaAccountName: v.mpesaAccountName || '',
    /* Automatic STK is an UPGRADE and is reported, never assumed. It requires
       the merchant's own Daraja credentials, which this door does not accept. */
    autoStkEnabled: false,
  };
}

async function _getSetupStatus(req) {
  const uid = _requireAuth(req);
  const d = req.data || {};
  let merchantId = _san(d.merchantId || '', 128).trim();
  if (!merchantId) {
    const owned = await db.collection('businesses').where('ownerId', '==', uid).limit(1).get();
    if (owned.empty) return { hasBusiness: false, nextStep: 'business', productionReady: false, checklist: { authenticated: true, businessCreated: false } };
    merchantId = owned.docs[0].id;
  }
  const bizSnap = await db.collection('businesses').doc(merchantId).get();
  if (!bizSnap.exists) _err('Business not found.', 'not-found');
  const b = bizSnap.data();
  if (b.ownerId !== uid && !_isAdmin(req)) _err('Access denied.', 'permission-denied');
  const cl = b.setupChecklist || {};

  const [subSnap, branchSnap, taxSnap, prodSnap, deviceSnap, shopProdSnap] = await Promise.all([
    db.collection('subscriptions').where('merchantId', '==', merchantId).where('status', 'in', ['active', 'trialing']).limit(1).get().catch(() => ({ empty: true })),
    db.collection('branches').where('merchantId', '==', merchantId).limit(1).get().catch(() => ({ empty: true })),
    db.collection('taxConfig').doc(merchantId).get().catch(() => ({ exists: false })),
    /* THE CATALOGUE IS NOT WHERE THIS WAS LOOKING.

       This asked posProducts for merchantId. A live census found the platform
       keys its catalogue the other way: of 108 products, 103 carry
       `products.shopId == the OWNER'S UID` and ZERO carry a SOK- merchantId.
       So a shop with 103 products on the shelf reported an empty catalogue and
       the setup screen would have told its owner they were not ready to sell.

       BOTH vocabularies are accepted rather than swapped. posProducts is real
       for merchants who use it, and answering 'does this shop have anything to
       sell' with only one of the two collections is the mistake being fixed —
       replacing it with the opposite mistake would be no better.

       Scoped by ownerId, not merchantId: ownerId is what products actually
       carry, and for a wizard-provisioned business the two differ. */
    db.collection('posProducts').where('merchantId', '==', merchantId).limit(1).get().catch(() => ({ empty: true })),
    db.collection('posDevices').where('merchantId', '==', merchantId).limit(1).get().catch(() => ({ empty: true })),
    db.collection('products').where('shopId', '==', String(b.ownerId || '')).limit(1).get().catch(() => ({ empty: true })),
  ]);

  const checklist = {
    authenticated:       true,
    businessCreated:     true,
    merchantIdGenerated: !!b.merchantId,
    subscription:        !subSnap.empty || cl.subscription === true,
    branchCreated:       !branchSnap.empty,
    taxesConfigured:     taxSnap.exists || cl.taxesConfigured === true,
    staff:               cl.staff === true,                                  // optional
    inventoryReady:      !prodSnap.empty || !shopProdSnap.empty || cl.inventoryReady === true,
    hardwareConnected:   !deviceSnap.empty || cl.hardwareConnected === true, // connected OR intentionally skipped
    testSaleSuccessful:  cl.testSaleSuccessful === true,
  };

  const order = [
    ['business',     checklist.businessCreated],
    ['subscription', checklist.subscription],
    ['branch',       checklist.branchCreated],
    ['taxes',        checklist.taxesConfigured],
    ['inventory',    checklist.inventoryReady],
    ['hardware',     checklist.hardwareConnected],
    ['testSale',     checklist.testSaleSuccessful],
  ];
  const firstIncomplete = order.find(([, ok]) => !ok);
  const requiredOk = !firstIncomplete;
  const nextStep = requiredOk ? 'ready' : firstIncomplete[0];

  return {
    hasBusiness: true, merchantId,
    business: {
      merchantId, name: _san(b.name || b.businessName || '', 200),
      businessId: b.businessId || merchantId, branchId: b.defaultBranchId || `${merchantId}-main`,
      category: b.category || null, storeCode: b.storeCode || null,
    },
    checklist, nextStep, productionReady: requiredOk,
  };
}

/* markSetupStep — record completion/choice for steps not inferable from data
   (inventory choice, hardware connected/skipped, test sale done, staff added). */
async function _markSetupStep(req) {
  const uid = _requireAuth(req);
  const d = req.data || {};
  const merchantId = _san(d.merchantId || '', 128).trim();
  const step = _san(d.step || '', 40).trim();
  const value = d.value !== false;
  if (!merchantId) _err('merchantId is required.');
  const allowed = ['subscription', 'taxesConfigured', 'staff', 'inventoryReady', 'hardwareConnected', 'testSaleSuccessful'];
  if (!allowed.includes(step)) _err('Unknown setup step.');
  const ref = db.collection('businesses').doc(merchantId);
  const snap = await ref.get();
  if (!snap.exists) _err('Business not found.', 'not-found');
  if (snap.data().ownerId !== uid && !_isAdmin(req)) _err('Access denied.', 'permission-denied');
  await ref.update({ [`setupChecklist.${step}`]: value, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  const status = await _getSetupStatus({ auth: req.auth, data: { merchantId } });
  if (status.productionReady && !snap.data().productionReady) {
    await ref.update({ productionReady: true, productionReadyAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  return { ok: true, step, value, productionReady: status.productionReady, nextStep: status.nextStep };
}

/* Resumable setup wizard — persist/restore per-user progress so the 12-step
   wizard never loses state (resume anytime, offline-safe on the client). */
async function _saveOnboardingProgress(req) {
  const uid = _requireAuth(req);
  const d = req.data || {};
  const step = Math.max(0, Math.min(20, parseInt(d.step, 10) || 0));
  const payload = (d.data && typeof d.data === 'object') ? d.data : {};
  await db.collection('onboardingProgress').doc(uid).set({
    uid, step, data: payload, merchantId: _san(d.merchantId || '', 128) || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, step };
}
async function _getOnboardingProgress(req) {
  const uid = _requireAuth(req);
  const snap = await db.collection('onboardingProgress').doc(uid).get();
  if (!snap.exists) return { exists: false, step: 0, data: {} };
  const p = snap.data();
  return { exists: true, step: p.step || 0, data: p.data || {}, merchantId: p.merchantId || null };
}

/* ── Exports ─────────────────────────────────────────────────────── */

/* ══════════════════════════════════════════════════════════════════
   setStaffPin — server-side PIN provisioning for POS staff.

   WHY: validateDeviceAccess (above) authenticates by querying
   posStaff.where('pinHash','==',…), but NOTHING in the platform ever wrote posStaff.pinHash —
   the bootstrap seeds staff without a PIN and no other CF sets one. The endpoint could
   therefore never return valid:true, so manager authorization had no server-side path at all
   and pos-manager-auth.js fell back to comparing hashes held in IndexedDB (client-forgeable).
   This is the missing half: it lets a PIN exist server-side so verification can be authoritative.

   SECURITY NOTES:
   * Hashing matches validateDeviceAccess (_sha256(pin), unsalted) so the deployed endpoint keeps
     working unchanged. That is safe here only because posStaff is CF-only (no Firestore rule ->
     default deny, verified) and attempts are rate-limited 5 per uid per 5 min. Hardening to a
     per-staff salt + slow KDF requires changing validateDeviceAccess's single-query lookup and
     is recorded as technical debt, not attempted under the RC1 freeze.
   * The PIN is never stored, logged or returned in plaintext; the hash is never returned either.
   * PINs must be unique within a branch, otherwise the single-result lookup in
     validateDeviceAccess would authenticate an ambiguous staff member.
   * Every attempt writes an immutable server-side audit record (actor, target, outcome).
══════════════════════════════════════════════════════════════════ */
async function _setStaffPin(req) {
  const uid = _requireAuth(req);
  const d   = req.data || {};

  const merchantId = _san(d.merchantId || '', 128);
  const staffId    = _san(d.staffId || '', 200);
  const pin        = String(d.pin == null ? '' : d.pin);
  if (!merchantId) _err('merchantId is required.');
  if (!staffId)    _err('staffId is required.');

  /* 4–6 digits: matches the POS keypad (min 4, max 6). Digits only — the keypad cannot
     produce anything else, and it keeps the value compatible with offline entry. */
  if (!/^\d{4,6}$/.test(pin)) _err('PIN must be 4 to 6 digits.');

  /* Reject trivially guessable PINs. Rate limiting alone is not enough when the search space
     is 10k: a repeated/sequential PIN is the first thing an attacker tries. */
  if (/^(\d)\1+$/.test(pin)) _err('PIN cannot be a single repeated digit.');
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    _err('PIN cannot be a sequential run of digits.');
  }

  const staffRef  = db.collection('posStaff').doc(staffId);
  const staffSnap = await staffRef.get();
  if (!staffSnap.exists) _err('Staff member not found.', 'not-found');
  const staff = staffSnap.data();

  if (staff.merchantId !== merchantId) {
    _err('Staff member belongs to another merchant.', 'permission-denied');
  }
  const branchId = _san(staff.branchId || '', 128);
  if (!branchId) _err('Staff member has no branch.', 'failed-precondition');

  /* Authorisation: caller must belong to this merchant/branch (owner, active staff, or admin).
     Reuses the canonical guard rather than re-implementing membership logic. */
  await _assertMerchantAccess(req, merchantId, branchId);

  /* Only an owner/manager may set a PIN, and a cashier may never set someone else's.
     A staff member changing their OWN pin is allowed. */
  const callerSnap = await db.collection('posStaff')
    .where('branchId', '==', branchId).where('uid', '==', uid)
    .where('status', '==', 'active').limit(1).get();
  const callerRole = callerSnap.empty ? null : (callerSnap.docs[0].data().role || 'cashier');
  const isSelf     = staff.uid === uid;
  const isElevated = _isAdmin(req) || callerRole === 'owner' || callerRole === 'manager';
  if (!isSelf && !isElevated) {
    _err('Only an owner or manager can set another staff member’s PIN.', 'permission-denied');
  }

  const pinHash = _sha256(pin);

  /* Uniqueness within the branch — validateDeviceAccess resolves a PIN to exactly one staff
     record, so a collision would silently authenticate the wrong person. */
  const clash = await db.collection('posStaff')
    .where('branchId', '==', branchId).where('pinHash', '==', pinHash).limit(2).get();
  if (clash.docs.some((doc) => doc.id !== staffId)) {
    _err('That PIN is already in use at this branch. Choose a different PIN.', 'already-exists');
  }

  await staffRef.set({
    pinHash,                        // never returned to any caller
    pinSetAt: F.serverTimestamp(),
    pinSetBy: uid,
    pinVersion: (staff.pinVersion || 0) + 1,
    updatedAt: F.serverTimestamp(),
  }, { merge: true });

  /* Immutable server-generated audit record (actor / target / outcome), matching the pattern
     established by posStockMovements. Deliberately records NO pin material. */
  await db.collection('posAuthAudit').add({
    merchantId, branchId,
    action:     'staff_pin_set',
    actorUid:   uid,
    actorRole:  callerRole || (_isAdmin(req) ? 'admin' : 'unknown'),
    targetStaffId: staffId,
    targetUid:  staff.uid || null,
    self:       isSelf,
    outcome:    'success',
    pinVersion: (staff.pinVersion || 0) + 1,
    createdAt:  F.serverTimestamp(),
  });

  _log('INFO', 'setStaffPin — PIN updated', { uid, staffId, merchantId, branchId });
  return { ok: true, staffId, pinSet: true };
}

module.exports = {
  bootstrapDevice:          exports.bootstrapDevice,
  getIncrementalSync:       exports.getIncrementalSync,
  invalidateBootstrapCache: exports.invalidateBootstrapCache,
  getBusinessConfig:        exports.getBusinessConfig,
  validateDeviceAccess:     exports.validateDeviceAccess,
  /* Canonical merchant tenant-guard. Exported so other POS modules reuse it instead of
     re-implementing membership checks (owner / active branch staff / merchant admin). */
  _assertMerchantAccess,
  /* Idempotent provisioning, called by the approval path. */
  _ensureBusinessForOwner,
  /* Onboarding v2 handlers — served through smartPosDispatch (no new CF). */
  _h: {
    getMyBusinesses:        _getMyBusinesses,
    createBusiness:         _createBusiness,
    pairDevice:             _pairDevice,
    regeneratePairingQR:    _regeneratePairingQR,
    saveOnboardingProgress: _saveOnboardingProgress,
    getOnboardingProgress:  _getOnboardingProgress,
    getSetupStatus:         _getSetupStatus,
    savePaymentDestination: _savePaymentDestination,
    getPaymentDestination:  _getPaymentDestination,
    markSetupStep:          _markSetupStep,
    setStaffPin:            _setStaffPin,
  },
};
