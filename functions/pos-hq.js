'use strict';

/**
 * pos-hq.js
 * SOKONI SmartPOS — Multi-Branch HQ Operations Cloud Functions
 *
 * Sections:
 *   A. Central Pricing         (setCentralPrice, getCentralPrices, pushPricesToBranches, removeCentralPrice)
 *   B. Shared Catalog          (syncCatalogToBranch, getSharedCatalogStatus, publishCatalogUpdate)
 *   C. Cross-Branch Fulfillment(checkStockAcrossBranches, createCrossBranchFulfillment, getCrossBranchFulfillments)
 *   D. Central Inventory Mgmt  (getHQInventoryOverview, createMasterInventoryTransfer)
 *   E. Regional Reporting      (getRegionalReport)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────
// Shared Config & Utilities
// ─────────────────────────────────────────────

const _CF  = { region: 'us-central1', enforceAppCheck: true };
const _TS  = () => admin.firestore.FieldValue.serverTimestamp();
const _INC = (n) => admin.firestore.FieldValue.increment(n);

/**
 * Assert authenticated caller.
 * @param {import('firebase-functions/v2/https').CallableRequest} req
 * @returns {import('firebase-functions/v2/https').CallableRequest['auth']}
 */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}

/**
 * Assert minimum POS role.
 * Role hierarchy: cashier(0) < supervisor(1) < manager(2) < owner(3)
 * @param {import('firebase-functions/v2/https').CallableRequest['auth']} auth
 * @param {'cashier'|'supervisor'|'manager'|'owner'} minRole
 */
function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3 };
  if ((levels[auth.token?.posRole || 'cashier'] ?? 0) < (levels[minRole] ?? 0))
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
}

/**
 * Sanitize a string value: strip dangerous chars, cap length.
 * @param {unknown} v
 * @param {number} max
 * @returns {string}
 */
function _san(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>"'`\\]/g, '').trim().slice(0, max);
}

/**
 * Coerce to safe finite number.
 * @param {unknown} v
 * @param {number} [def=0]
 * @returns {number}
 */
function _num(v, def = 0) {
  const n = parseFloat(v);
  return isFinite(n) ? n : def;
}

/**
 * Assert a required string field is present and non-empty.
 * @param {unknown} v
 * @param {string} name
 * @returns {string}
 */
function _req(v, name) {
  if (typeof v !== 'string' || !v.trim())
    throw new HttpsError('invalid-argument', `Missing required field: ${name}`);
  return v.trim();
}

/**
 * Assert a required positive number field.
 * @param {unknown} v
 * @param {string} name
 * @returns {number}
 */
function _reqNum(v, name) {
  const n = parseFloat(v);
  if (!isFinite(n) || n < 0)
    throw new HttpsError('invalid-argument', `Invalid numeric field: ${name}`);
  return n;
}

/**
 * Structured log helper.
 * @param {'INFO'|'WARNING'|'ERROR'|'NOTICE'} severity
 * @param {string} msg
 * @param {object} [extra]
 */
function _log(severity, msg, extra = {}) {
  const entry = { severity, message: msg, service: 'pos-hq', ...extra };
  if (severity === 'ERROR') {
    console.error(JSON.stringify(entry));
  } else if (severity === 'WARNING') {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION A — CENTRAL PRICING
// Collection: posCentralPrices/{sellerId_productId}
// ══════════════════════════════════════════════════════════════════════════════

/**
 * setCentralPrice
 * Role: owner
 * Creates or updates a centralised price override for a product.
 *
 * Input:
 *   sellerId      {string}  — seller (business) ID
 *   productId     {string}  — product document ID
 *   productName   {string}  — human-readable product name (for display)
 *   price         {number}  — selling price (KES)
 *   salePrice     {number?} — optional promotional price
 *   costPrice     {number?} — cost / landed price
 *   effectiveDate {string}  — ISO date string when price becomes active
 *   expiresDate   {string?} — ISO date string when override expires (null = never)
 *   branchOverride{string}  — specific branchId or 'all'
 *
 * Output:
 *   { id, sellerId, productId, price, updatedAt }
 */
exports.setCentralPrice = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const {
    sellerId, productId, productName,
    price, salePrice, costPrice,
    effectiveDate, expiresDate,
    branchOverride,
  } = req.data;

  const sid = _req(sellerId, 'sellerId');
  const pid = _req(productId, 'productId');
  const name = _san(productName, 200);
  const priceVal = _reqNum(price, 'price');
  const salePriceVal = salePrice != null ? _reqNum(salePrice, 'salePrice') : null;
  const costPriceVal = costPrice != null ? _reqNum(costPrice, 'costPrice') : null;
  const effDate = _req(effectiveDate, 'effectiveDate');
  const expDate = expiresDate ? _san(expiresDate, 30) : null;
  const branch = _san(branchOverride || 'all', 100);

  // Validate the caller belongs to this seller or is a super-admin
  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Cannot manage prices for another seller');
  }

  const docId = `${sid}_${pid}`;
  const docRef = db.collection('posCentralPrices').doc(docId);

  const payload = {
    sellerId: sid,
    productId: pid,
    productName: name,
    price: priceVal,
    salePrice: salePriceVal,
    costPrice: costPriceVal,
    effectiveDate: effDate,
    expiresDate: expDate,
    branchOverride: branch,
    setBy: auth.uid,
    updatedAt: _TS(),
  };

  // Preserve createdAt on first write
  const existing = await docRef.get();
  if (!existing.exists) {
    payload.createdAt = _TS();
  }

  await docRef.set(payload, { merge: true });

  _log('NOTICE', 'Central price set', { docId, sellerId: sid, productId: pid, price: priceVal, setBy: auth.uid });

  return { id: docId, sellerId: sid, productId: pid, price: priceVal, updatedAt: new Date().toISOString() };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * getCentralPrices
 * Role: cashier+ (any authenticated user belonging to this seller)
 * Returns all central price overrides for a given sellerId.
 *
 * Input:
 *   sellerId {string}
 *
 * Output:
 *   { prices: [...], count: number }
 */
exports.getCentralPrices = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);

  const sid = _req(req.data?.sellerId, 'sellerId');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  const snap = await db.collection('posCentralPrices')
    .where('sellerId', '==', sid)
    .orderBy('updatedAt', 'desc')
    .limit(500)
    .get();

  const prices = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  return { prices, count: prices.length };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * pushPricesToBranches
 * Role: owner
 * Propagates central price overrides to the live products collection
 * for every branch under this seller.
 *
 * Input:
 *   sellerId   {string}
 *   productIds {string[]|'all'} — array of productIds or the literal string 'all'
 *
 * Output:
 *   { updated: number, failed: number, skipped: number, errors: string[] }
 */
exports.pushPricesToBranches = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const { sellerId, productIds } = req.data;
  const sid = _req(sellerId, 'sellerId');
  const pids = productIds; // 'all' or string[]

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Cannot push prices for another seller');
  }

  // 1. Fetch central prices
  let cpQuery = db.collection('posCentralPrices').where('sellerId', '==', sid);
  if (pids !== 'all' && Array.isArray(pids) && pids.length > 0) {
    if (pids.length > 30) throw new HttpsError('invalid-argument', 'Max 30 productIds per push');
    cpQuery = cpQuery.where('productId', 'in', pids.slice(0, 30));
  }
  const cpSnap = await cpQuery.limit(200).get();

  if (cpSnap.empty) {
    return { updated: 0, failed: 0, skipped: 0, errors: [], message: 'No central prices found' };
  }

  // 2. Fetch branches for this seller
  const branchSnap = await db.collection('branches')
    .where('sellerId', '==', sid)
    .where('active', '==', true)
    .limit(100)
    .get();

  if (branchSnap.empty) {
    return { updated: 0, failed: 0, skipped: 0, errors: [], message: 'No active branches found' };
  }

  const branches = branchSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];

  // 3. For each central price, update product in each matching branch
  const now = new Date().toISOString();

  for (const cpDoc of cpSnap.docs) {
    const cp = cpDoc.data();

    // Respect effectiveDate — skip if not yet active
    if (cp.effectiveDate && cp.effectiveDate > now) {
      skipped++;
      continue;
    }
    // Respect expiresDate — skip if expired
    if (cp.expiresDate && cp.expiresDate < now) {
      skipped++;
      continue;
    }

    const targetBranches = cp.branchOverride === 'all'
      ? branches
      : branches.filter(b => b.id === cp.branchOverride);

    for (const branch of targetBranches) {
      try {
        // Products are stored under sellers/{sellerId}/branches/{branchId}/products/{productId}
        // Fallback: also try top-level products collection keyed by sellerId+branchId
        const productRef = db
          .collection('sellers').doc(sid)
          .collection('branches').doc(branch.id)
          .collection('products').doc(cp.productId);

        const priceUpdate = {
          price: cp.price,
          updatedAt: _TS(),
          centralPriceApplied: true,
          centralPriceId: cpDoc.id,
          centralPriceSetAt: now,
        };
        if (cp.salePrice != null) priceUpdate.salePrice = cp.salePrice;
        if (cp.costPrice != null) priceUpdate.costPrice = cp.costPrice;

        await productRef.set(priceUpdate, { merge: true });
        updated++;
      } catch (err) {
        failed++;
        const errMsg = `Branch ${branch.id} / Product ${cp.productId}: ${err.message}`;
        errors.push(errMsg);
        _log('ERROR', 'pushPricesToBranches error', { errMsg, sellerId: sid });
      }
    }
  }

  _log('NOTICE', 'Prices pushed to branches', { sellerId: sid, updated, failed, skipped, pushedBy: auth.uid });

  return { updated, failed, skipped, errors: errors.slice(0, 50) };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * removeCentralPrice
 * Role: owner
 * Deletes the central price override for a specific product.
 *
 * Input:
 *   sellerId  {string}
 *   productId {string}
 *
 * Output:
 *   { deleted: boolean, id: string }
 */
exports.removeCentralPrice = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const sid = _req(req.data?.sellerId, 'sellerId');
  const pid = _req(req.data?.productId, 'productId');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Cannot remove price for another seller');
  }

  const docId = `${sid}_${pid}`;
  const docRef = db.collection('posCentralPrices').doc(docId);
  const snap = await docRef.get();

  if (!snap.exists) {
    throw new HttpsError('not-found', `No central price found for product ${pid}`);
  }

  await docRef.delete();

  _log('NOTICE', 'Central price removed', { docId, sellerId: sid, productId: pid, removedBy: auth.uid });

  return { deleted: true, id: docId };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION B — SHARED CATALOG
// Collection: posSharedCatalog/{sellerId}
// ══════════════════════════════════════════════════════════════════════════════

/**
 * syncCatalogToBranch
 * Role: manager+
 * Copies the HQ product catalog to the specified branch.
 * This is additive/merge — it does not delete branch-only products.
 *
 * Input:
 *   sellerId {string}
 *   branchId {string}
 *
 * Output:
 *   { synced: number, skipped: number, catalogVersion: number, syncedAt: string }
 */
exports.syncCatalogToBranch = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const sid = _req(req.data?.sellerId, 'sellerId');
  const bid = _req(req.data?.branchId, 'branchId');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  // Verify branch exists and belongs to seller
  const branchRef = db.collection('sellers').doc(sid).collection('branches').doc(bid);
  const branchSnap = await branchRef.get();
  if (!branchSnap.exists) {
    throw new HttpsError('not-found', `Branch ${bid} not found`);
  }

  // Fetch HQ catalog (stored in sellers/{sellerId}/products)
  const hqProductsSnap = await db
    .collection('sellers').doc(sid)
    .collection('products')
    .limit(1000)
    .get();

  if (hqProductsSnap.empty) {
    return { synced: 0, skipped: 0, catalogVersion: 0, syncedAt: new Date().toISOString() };
  }

  // Get current catalog metadata
  const catalogRef = db.collection('posSharedCatalog').doc(sid);
  const catalogSnap = await catalogRef.get();
  const catalogData = catalogSnap.exists ? catalogSnap.data() : { version: 1, productCount: 0 };
  const catalogVersion = catalogData.version || 1;

  const branchProductsCol = db
    .collection('sellers').doc(sid)
    .collection('branches').doc(bid)
    .collection('products');

  let synced = 0;
  let skipped = 0;
  const syncedAt = new Date().toISOString();

  // Batch writes (max 500 per batch)
  const BATCH_SIZE = 400;
  let batch = db.batch();
  let batchCount = 0;

  for (const productDoc of hqProductsSnap.docs) {
    const productData = productDoc.data();
    const branchProductRef = branchProductsCol.doc(productDoc.id);

    // Merge: preserve branch-specific overrides (e.g. local stock)
    const mergePayload = {
      ...productData,
      syncedFromHQ: true,
      catalogVersion,
      lastSyncAt: _TS(),
    };

    batch.set(branchProductRef, mergePayload, { merge: true });
    synced++;
    batchCount++;

    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  // Update catalog sync metadata
  const syncRecord = {
    [`branches.${bid}.lastSyncAt`]: syncedAt,
    [`branches.${bid}.syncedBy`]: auth.uid,
    [`branches.${bid}.productsSynced`]: synced,
    updatedAt: _TS(),
  };
  await catalogRef.set(syncRecord, { merge: true });

  _log('INFO', 'Catalog synced to branch', { sellerId: sid, branchId: bid, synced, catalogVersion });

  return { synced, skipped, catalogVersion, syncedAt };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * getSharedCatalogStatus
 * Role: cashier+ (any authenticated member of this seller)
 * Returns catalog version, product count, and per-branch sync status.
 *
 * Input:
 *   sellerId {string}
 *
 * Output:
 *   { version, productCount, branches: { [branchId]: { lastSyncAt, syncedBy, productsSynced } } }
 */
exports.getSharedCatalogStatus = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);

  const sid = _req(req.data?.sellerId, 'sellerId');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  const [catalogSnap, hqProductsSnap] = await Promise.all([
    db.collection('posSharedCatalog').doc(sid).get(),
    db.collection('sellers').doc(sid).collection('products').count().get(),
  ]);

  const catalogData = catalogSnap.exists ? catalogSnap.data() : {};
  const productCount = hqProductsSnap.data().count;

  return {
    version: catalogData.version || 1,
    productCount,
    needsSync: catalogData.needsSync || false,
    lastPublishedAt: catalogData.lastPublishedAt || null,
    branches: catalogData.branches || {},
  };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * publishCatalogUpdate
 * Role: owner
 * Increments catalog version and marks all branches as needing sync.
 * Branches will detect needsSync=true and prompt managers to re-sync.
 *
 * Input:
 *   sellerId      {string}
 *   changeNotes   {string?} — optional human-readable description of what changed
 *
 * Output:
 *   { version: number, branchesMarked: number, publishedAt: string }
 */
exports.publishCatalogUpdate = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const sid = _req(req.data?.sellerId, 'sellerId');
  const changeNotes = _san(req.data?.changeNotes || '', 500);

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Cannot publish catalog for another seller');
  }

  const catalogRef = db.collection('posSharedCatalog').doc(sid);
  const catalogSnap = await catalogRef.get();
  const existing = catalogSnap.exists ? catalogSnap.data() : {};
  const newVersion = (existing.version || 0) + 1;

  // Fetch all active branches to mark them
  const branchSnap = await db.collection('sellers').doc(sid).collection('branches')
    .where('active', '==', true)
    .limit(100)
    .get();

  const branchUpdates = {};
  for (const b of branchSnap.docs) {
    branchUpdates[`branches.${b.id}.needsSync`] = true;
    branchUpdates[`branches.${b.id}.pendingVersion`] = newVersion;
  }

  const publishedAt = new Date().toISOString();

  await catalogRef.set({
    version: newVersion,
    needsSync: true,
    lastPublishedAt: publishedAt,
    publishedBy: auth.uid,
    changeNotes,
    updatedAt: _TS(),
    ...branchUpdates,
  }, { merge: true });

  // Write to catalog history sub-collection
  await db.collection('posSharedCatalog').doc(sid)
    .collection('history').add({
      version: newVersion,
      publishedAt,
      publishedBy: auth.uid,
      changeNotes,
      createdAt: _TS(),
    });

  _log('NOTICE', 'Catalog update published', {
    sellerId: sid, newVersion, branchesMarked: branchSnap.size, publishedBy: auth.uid,
  });

  return { version: newVersion, branchesMarked: branchSnap.size, publishedAt };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION C — CROSS-BRANCH FULFILLMENT
// Collection: inventoryTransfers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * checkStockAcrossBranches
 * Role: cashier+
 * Returns current stock levels for a product across all active branches.
 *
 * Input:
 *   sellerId  {string}
 *   productId {string}
 *
 * Output:
 *   { productId, results: [{ branchId, branchName, stock, reserved, available }], totalStock }
 */
exports.checkStockAcrossBranches = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);

  const sid = _req(req.data?.sellerId, 'sellerId');
  const pid = _req(req.data?.productId, 'productId');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  // Fetch all active branches
  const branchSnap = await db.collection('sellers').doc(sid).collection('branches')
    .where('active', '==', true)
    .limit(100)
    .get();

  if (branchSnap.empty) {
    return { productId: pid, results: [], totalStock: 0 };
  }

  // Fetch product stock from each branch in parallel
  const stockPromises = branchSnap.docs.map(async (branchDoc) => {
    const branchData = branchDoc.data();
    try {
      const productSnap = await db
        .collection('sellers').doc(sid)
        .collection('branches').doc(branchDoc.id)
        .collection('products').doc(pid)
        .get();

      if (!productSnap.exists) {
        return { branchId: branchDoc.id, branchName: branchData.name || branchDoc.id, stock: 0, reserved: 0, available: 0, found: false };
      }

      const pd = productSnap.data();
      const stock = _num(pd.stock, 0);
      const reserved = _num(pd.reservedStock, 0);
      const available = Math.max(0, stock - reserved);

      return {
        branchId: branchDoc.id,
        branchName: branchData.name || branchDoc.id,
        stock,
        reserved,
        available,
        found: true,
      };
    } catch (err) {
      _log('WARNING', 'checkStockAcrossBranches branch fetch failed', { branchId: branchDoc.id, err: err.message });
      return { branchId: branchDoc.id, branchName: branchData.name || branchDoc.id, stock: 0, reserved: 0, available: 0, found: false, error: true };
    }
  });

  const results = (await Promise.all(stockPromises))
    .sort((a, b) => b.stock - a.stock);

  const totalStock = results.reduce((sum, r) => sum + r.stock, 0);

  return { productId: pid, results, totalStock };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * createCrossBranchFulfillment
 * Role: manager+
 * Creates an inventory transfer request between two branches.
 *
 * Input:
 *   sellerId          {string}
 *   productId         {string}
 *   productName       {string}
 *   quantity          {number}
 *   sourceBranchId    {string}
 *   destinationBranchId {string}
 *   customerOrderId   {string?} — linked customer order, if any
 *   notes             {string?}
 *
 * Output:
 *   { transferId, status, createdAt }
 */
exports.createCrossBranchFulfillment = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const {
    sellerId, productId, productName,
    quantity, sourceBranchId, destinationBranchId,
    customerOrderId, notes,
  } = req.data;

  const sid = _req(sellerId, 'sellerId');
  const pid = _req(productId, 'productId');
  const pname = _san(productName, 200);
  const qty = _reqNum(quantity, 'quantity');
  if (qty <= 0 || !Number.isInteger(qty)) {
    throw new HttpsError('invalid-argument', 'Quantity must be a positive integer');
  }
  const srcBid = _req(sourceBranchId, 'sourceBranchId');
  const dstBid = _req(destinationBranchId, 'destinationBranchId');

  if (srcBid === dstBid) {
    throw new HttpsError('invalid-argument', 'Source and destination branches must differ');
  }

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  // Check source has enough stock
  const srcProductSnap = await db
    .collection('sellers').doc(sid)
    .collection('branches').doc(srcBid)
    .collection('products').doc(pid)
    .get();

  if (!srcProductSnap.exists) {
    throw new HttpsError('not-found', `Product ${pid} not found in source branch ${srcBid}`);
  }
  const srcStock = _num(srcProductSnap.data().stock, 0);
  const srcReserved = _num(srcProductSnap.data().reservedStock, 0);
  const srcAvailable = Math.max(0, srcStock - srcReserved);
  if (qty > srcAvailable) {
    throw new HttpsError('failed-precondition', `Insufficient stock. Available: ${srcAvailable}, Requested: ${qty}`);
  }

  const transferId = `XBF-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const now = new Date().toISOString();

  const transferDoc = {
    transferId,
    sellerId: sid,
    productId: pid,
    productName: pname,
    quantity: qty,
    sourceBranchId: srcBid,
    destinationBranchId: dstBid,
    customerOrderId: customerOrderId ? _san(customerOrderId, 100) : null,
    notes: notes ? _san(notes, 500) : null,
    status: 'pending_pickup',
    createdBy: auth.uid,
    createdAt: _TS(),
    updatedAt: _TS(),
    statusHistory: [{
      status: 'pending_pickup',
      changedBy: auth.uid,
      changedAt: now,
    }],
  };

  await db.collection('inventoryTransfers').doc(transferId).set(transferDoc);

  // Reserve stock at source to prevent oversell
  await db
    .collection('sellers').doc(sid)
    .collection('branches').doc(srcBid)
    .collection('products').doc(pid)
    .update({ reservedStock: admin.firestore.FieldValue.increment(qty), updatedAt: _TS() });

  _log('NOTICE', 'Cross-branch fulfillment created', {
    transferId, sellerId: sid, productId: pid, quantity: qty, sourceBranchId: srcBid, destinationBranchId: dstBid,
  });

  return { transferId, status: 'pending_pickup', createdAt: now };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * getCrossBranchFulfillments
 * Role: manager+
 * Returns cross-branch transfer records for a seller, optionally filtered by status.
 *
 * Input:
 *   sellerId    {string}
 *   status      {string?} — filter by status (pending_pickup|in_transit|completed|cancelled)
 *   branchId    {string?} — filter by source or destination branch
 *
 * Output:
 *   { transfers: [...], count: number }
 */
exports.getCrossBranchFulfillments = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');

  const sid = _req(req.data?.sellerId, 'sellerId');
  const statusFilter = req.data?.status ? _san(req.data.status, 50) : null;
  const branchFilter = req.data?.branchId ? _san(req.data.branchId, 100) : null;

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  let q = db.collection('inventoryTransfers').where('sellerId', '==', sid);

  if (statusFilter) {
    const validStatuses = ['pending_pickup', 'in_transit', 'completed', 'cancelled'];
    if (!validStatuses.includes(statusFilter)) {
      throw new HttpsError('invalid-argument', `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
    q = q.where('status', '==', statusFilter);
  }

  const snap = await q.orderBy('createdAt', 'desc').limit(50).get();

  let transfers = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Optional branch filter (applied in-memory since Firestore can't do OR on two fields)
  if (branchFilter) {
    transfers = transfers.filter(
      t => t.sourceBranchId === branchFilter || t.destinationBranchId === branchFilter,
    );
  }

  return { transfers, count: transfers.length };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION D — CENTRAL INVENTORY MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getHQInventoryOverview
 * Role: owner
 * Aggregates stock levels across all active branches for a seller.
 * Returns per-product summary with stock by branch and a stock-alert flag.
 *
 * Input:
 *   sellerId        {string}
 *   lowStockThreshold {number?} — default 10
 *
 * Output:
 *   { products: [...], totalBranches, generatedAt }
 */
exports.getHQInventoryOverview = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const sid = _req(req.data?.sellerId, 'sellerId');
  const lowThreshold = _num(req.data?.lowStockThreshold, 10);

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  // Fetch all active branches
  const branchSnap = await db.collection('sellers').doc(sid).collection('branches')
    .where('active', '==', true)
    .limit(100)
    .get();

  if (branchSnap.empty) {
    return { products: [], totalBranches: 0, generatedAt: new Date().toISOString() };
  }

  // Aggregate product stock from all branches in parallel
  const branchProductMaps = await Promise.all(
    branchSnap.docs.map(async (branchDoc) => {
      const branchName = branchDoc.data().name || branchDoc.id;
      const productsSnap = await db
        .collection('sellers').doc(sid)
        .collection('branches').doc(branchDoc.id)
        .collection('products')
        .limit(1000)
        .get();

      const map = {};
      for (const pd of productsSnap.docs) {
        const data = pd.data();
        map[pd.id] = {
          productId: pd.id,
          productName: data.name || data.productName || pd.id,
          category: data.category || 'Uncategorised',
          stock: _num(data.stock, 0),
          reorderPoint: _num(data.reorderPoint, 0),
          branchId: branchDoc.id,
          branchName,
        };
      }
      return { branchId: branchDoc.id, branchName, map };
    }),
  );

  // Merge into per-product summary
  const productMap = {}; // productId -> { productId, productName, stockByBranch, totalStock, stockAlert }

  for (const { branchId, branchName, map } of branchProductMaps) {
    for (const [pid, entry] of Object.entries(map)) {
      if (!productMap[pid]) {
        productMap[pid] = {
          productId: pid,
          productName: entry.productName,
          category: entry.category,
          stockByBranch: {},
          totalStock: 0,
          reorderPoint: entry.reorderPoint,
          stockAlert: false,
        };
      }
      productMap[pid].stockByBranch[branchId] = {
        branchName,
        stock: entry.stock,
      };
      productMap[pid].totalStock += entry.stock;
    }
  }

  // Compute stock alerts
  const products = Object.values(productMap).map(p => {
    p.stockAlert = p.totalStock <= Math.max(lowThreshold, p.reorderPoint);
    return p;
  }).sort((a, b) => {
    // Sort: stock alerts first, then alphabetically
    if (a.stockAlert && !b.stockAlert) return -1;
    if (!a.stockAlert && b.stockAlert) return 1;
    return a.productName.localeCompare(b.productName);
  });

  return {
    products,
    totalBranches: branchSnap.size,
    lowStockCount: products.filter(p => p.stockAlert).length,
    generatedAt: new Date().toISOString(),
  };
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * createMasterInventoryTransfer
 * Role: owner
 * Bulk transfer from HQ warehouse to multiple branches.
 *
 * Input:
 *   sellerId  {string}
 *   transfers [{branchId, productId, productName, quantity, notes?}]
 *
 * Output:
 *   { created: number, failed: number, transferIds: string[], errors: string[] }
 */
exports.createMasterInventoryTransfer = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const { sellerId, transfers } = req.data;
  const sid = _req(sellerId, 'sellerId');

  if (!Array.isArray(transfers) || transfers.length === 0) {
    throw new HttpsError('invalid-argument', 'transfers must be a non-empty array');
  }
  if (transfers.length > 100) {
    throw new HttpsError('invalid-argument', 'Maximum 100 transfers per call');
  }

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  let created = 0;
  let failed = 0;
  const transferIds = [];
  const errors = [];

  for (const item of transfers) {
    try {
      const bid = _req(item.branchId, 'branchId');
      const pid = _req(item.productId, 'productId');
      const pname = _san(item.productName || '', 200);
      const qty = _reqNum(item.quantity, 'quantity');
      if (qty <= 0) throw new Error('Quantity must be positive');

      const transferId = `MIT-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const now = new Date().toISOString();

      await db.collection('inventoryTransfers').doc(transferId).set({
        transferId,
        sellerId: sid,
        productId: pid,
        productName: pname,
        quantity: qty,
        sourceBranchId: 'hq_warehouse',
        destinationBranchId: bid,
        notes: item.notes ? _san(item.notes, 500) : null,
        status: 'pending_pickup',
        transferType: 'master_inventory',
        createdBy: auth.uid,
        createdAt: _TS(),
        updatedAt: _TS(),
        statusHistory: [{ status: 'pending_pickup', changedBy: auth.uid, changedAt: now }],
      });

      transferIds.push(transferId);
      created++;
    } catch (err) {
      failed++;
      errors.push(`Item [${item.productId || '?'}→${item.branchId || '?'}]: ${err.message}`);
      _log('ERROR', 'createMasterInventoryTransfer item error', { item, err: err.message, sellerId: sid });
    }
  }

  _log('NOTICE', 'Master inventory transfers created', {
    sellerId: sid, created, failed, createdBy: auth.uid,
  });

  return { created, failed, transferIds, errors: errors.slice(0, 50) };
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION E — REGIONAL REPORTING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getRegionalReport
 * Role: owner
 * Aggregates revenue and transaction data per branch for a date range.
 *
 * Input:
 *   sellerId  {string}
 *   startDate {string} — ISO date string (YYYY-MM-DD)
 *   endDate   {string} — ISO date string (YYYY-MM-DD)
 *
 * Output:
 *   {
 *     branches: [{ branchId, branchName, revenue, transactions, avgBasket, topProduct }],
 *     hqTotals: { revenue, transactions, avgBasket },
 *     period: { startDate, endDate },
 *     generatedAt
 *   }
 */
exports.getRegionalReport = onCall(_CF, async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'owner');

  const { sellerId, startDate, endDate } = req.data;
  const sid = _req(sellerId, 'sellerId');
  const start = _req(startDate, 'startDate');
  const end = _req(endDate, 'endDate');

  const callerSellerId = auth.token?.sellerId;
  const isAdmin = auth.token?.admin || auth.token?.role === 'super_admin';
  if (!isAdmin && callerSellerId !== sid) {
    throw new HttpsError('permission-denied', 'Access denied for this seller');
  }

  // Validate dates
  const startTs = new Date(start);
  const endTs = new Date(end);
  if (isNaN(startTs.getTime()) || isNaN(endTs.getTime())) {
    throw new HttpsError('invalid-argument', 'Invalid startDate or endDate');
  }
  if (endTs < startTs) {
    throw new HttpsError('invalid-argument', 'endDate must be after startDate');
  }
  const diffMs = endTs.getTime() - startTs.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays > 366) {
    throw new HttpsError('invalid-argument', 'Date range cannot exceed 366 days');
  }

  // Fetch all active branches
  const branchSnap = await db.collection('sellers').doc(sid).collection('branches')
    .where('active', '==', true)
    .limit(100)
    .get();

  if (branchSnap.empty) {
    return {
      branches: [],
      hqTotals: { revenue: 0, transactions: 0, avgBasket: 0 },
      period: { startDate: start, endDate: end },
      generatedAt: new Date().toISOString(),
    };
  }

  // Aggregate sales per branch in parallel
  const branchReports = await Promise.all(
    branchSnap.docs.map(async (branchDoc) => {
      const branchData = branchDoc.data();
      const bid = branchDoc.id;
      const bname = branchData.name || bid;

      try {
        const salesSnap = await db.collection('posSales')
          .where('sellerId', '==', sid)
          .where('branchId', '==', bid)
          .where('saleDate', '>=', start)
          .where('saleDate', '<=', end)
          .where('status', '==', 'completed')
          .limit(2000)
          .get();

        let revenue = 0;
        const productRevenue = {}; // productId -> { name, revenue }

        for (const saleDoc of salesSnap.docs) {
          const sale = saleDoc.data();
          const total = _num(sale.totalAmount || sale.total, 0);
          revenue += total;

          // Accumulate product revenue
          if (Array.isArray(sale.items)) {
            for (const item of sale.items) {
              const itemPid = item.productId || '';
              const itemName = item.productName || item.name || itemPid;
              const itemRevenue = _num(item.quantity, 1) * _num(item.price || item.unitPrice, 0);
              if (!productRevenue[itemPid]) {
                productRevenue[itemPid] = { productId: itemPid, name: itemName, revenue: 0 };
              }
              productRevenue[itemPid].revenue += itemRevenue;
            }
          }
        }

        const transactions = salesSnap.size;
        const avgBasket = transactions > 0 ? Math.round((revenue / transactions) * 100) / 100 : 0;

        // Top product by revenue
        const topProduct = Object.values(productRevenue)
          .sort((a, b) => b.revenue - a.revenue)[0] || null;

        return {
          branchId: bid,
          branchName: bname,
          revenue: Math.round(revenue * 100) / 100,
          transactions,
          avgBasket,
          topProduct,
          error: null,
        };
      } catch (err) {
        _log('ERROR', 'getRegionalReport branch error', { branchId: bid, err: err.message, sellerId: sid });
        return { branchId: bid, branchName: bname, revenue: 0, transactions: 0, avgBasket: 0, topProduct: null, error: err.message };
      }
    }),
  );

  // Sort by revenue descending
  branchReports.sort((a, b) => b.revenue - a.revenue);

  // HQ totals
  const hqRevenue = branchReports.reduce((sum, b) => sum + b.revenue, 0);
  const hqTransactions = branchReports.reduce((sum, b) => sum + b.transactions, 0);
  const hqAvgBasket = hqTransactions > 0
    ? Math.round((hqRevenue / hqTransactions) * 100) / 100
    : 0;

  return {
    branches: branchReports,
    hqTotals: {
      revenue: Math.round(hqRevenue * 100) / 100,
      transactions: hqTransactions,
      avgBasket: hqAvgBasket,
    },
    period: { startDate: start, endDate: end },
    generatedAt: new Date().toISOString(),
  };
});
