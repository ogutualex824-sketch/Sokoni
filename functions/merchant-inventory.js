'use strict';
/**
 * SOKONI Merchant Inventory — the ONE authority for a stock CORRECTION.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Two things change `products.stock`, and they mean different things:
 *
 *   A SALE            posCompleteCheckout → stock down, sale event, money
 *   A CORRECTION      here               → stock moves, movement record, NO sale
 *
 * Before this module there was no server authority for the second one. The only
 * client path to the canonical field was `sokoni-db.updateProductStock()`, which
 * writes `stock: increment(delta)` AND `sold: increment(-delta)` — so a merchant
 * counting three damaged units off the shelf silently recorded three SALES.
 * `inventoryAdjustStock` (inventory-engine.js) was no help either: it writes
 * `tenants/{id}/inventory_levels|movements|products`, a different counter from
 * the one POS deducts and the catalogue reads. Using it would have given one
 * shelf two numbers.
 *
 * So: this is the FIRST authority over corrections to canonical `products.stock`,
 * not a second one. It is deliberately narrow.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *   sale        → posCompleteCheckout → stock ↓ → sale event    → sold ↑
 *   correction  → merchantAdjustStock → stock ⇅ → movement      → sold UNCHANGED
 *
 * `products.sold` is never read, written, incremented or defaulted here. A
 * correction is not a sale and must never look like one in any aggregate.
 *
 * ── Authorisation ───────────────────────────────────────────────────────────
 * Ownership is resolved from Firestore (shop owner, shop employee, or platform
 * admin) using the same rule analytics-engine already applies — NOT from the
 * caller's `seller` claim. The claim population is known-divergent (0 of 11
 * sellers hold it), so gating on it would lock every real merchant out of their
 * own stock. The shop document is the authority on who owns the shop.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * The caller supplies `adjustmentId`. The movement document is claimed under
 * that id INSIDE the transaction, so a double tap, a retried call, or a
 * duplicated network attempt applies the delta exactly once and returns the
 * original result.
 *
 * Exports (re-exported by name from functions/index.js):
 *   merchantAdjustStock   onCall  — the sole canonical stock-correction path
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const logger = require('firebase-functions/logger');

const REGION = 'us-central1';
const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();

/* Why the stock moved. A correction without a stated reason is an unexplained
   inventory change, which is exactly what an audit cannot work with. */
const REASONS = Object.freeze([
  'count_correction', 'damage', 'theft', 'expiry',
  'restock', 'return_to_supplier', 'transfer', 'other',
]);

const _san = (v, n = 200) => String(v == null ? '' : v).slice(0, n).replace(/[<>"]/g, '').trim();

/**
 * Owner, employee, or platform admin — resolved from data, mirroring
 * analytics-engine's `_assertShop`. Throws HttpsError, never a bare Error, so
 * the client receives a code it can act on.
 */
async function assertShopAccess(uid, shopId) {
  const db = _db();
  const shopSnap = await db.collection('shops').doc(shopId).get();
  if (!shopSnap.exists) throw new HttpsError('not-found', 'Shop not found.');
  const shop = shopSnap.data() || {};
  if (shop.ownerId === uid) return 'owner';

  const empSnap = await db.collection('shopEmployees').doc(`${shopId}_${uid}`).get();
  if (empSnap.exists) return empSnap.data().role || 'employee';

  try {
    const claims = (await getAuth().getUser(uid)).customClaims || {};
    if (claims.admin === true || claims.superAdmin === true) return 'admin';
  } catch (_) { /* an unresolvable account is simply not an admin */ }

  throw new HttpsError('permission-denied', 'You do not have access to this shop.');
}

exports.merchantAdjustStock = onCall(
  { region: REGION, maxInstances: 20, memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: true },
  async (req) => {
    /* ── 1. Authenticate ─────────────────────────────────────────────────── */
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to adjust stock.');

    const d = req.data || {};
    const productId = _san(d.productId, 200);
    const shopId = _san(d.shopId, 200);
    const adjustmentId = _san(d.adjustmentId, 200);
    const reason = _san(d.reason, 40);
    const note = _san(d.note, 500);
    const delta = Number(d.delta);

    /* ── 2. Validate ─────────────────────────────────────────────────────── */
    if (!productId) throw new HttpsError('invalid-argument', 'productId is required.');
    if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required.');
    if (!adjustmentId) throw new HttpsError('invalid-argument', 'adjustmentId is required (it makes the adjustment idempotent).');
    if (!Number.isFinite(delta) || !Number.isInteger(delta) || delta === 0) {
      throw new HttpsError('invalid-argument', 'delta must be a non-zero whole number.');
    }
    if (Math.abs(delta) > 1000000) throw new HttpsError('invalid-argument', 'delta is implausibly large.');
    if (!REASONS.includes(reason)) {
      throw new HttpsError('invalid-argument', `reason must be one of: ${REASONS.join(', ')}.`);
    }

    /* ── 3. Authorise against the SHOP, not the claim ────────────────────── */
    const role = await assertShopAccess(uid, shopId);

    /* ── 4. Apply, once ──────────────────────────────────────────────────── */
    const db = _db();
    const prodRef = db.collection('products').doc(productId);
    const mvRef = db.collection('stockMovements').doc(adjustmentId);

    const result = await db.runTransaction(async (t) => {
      /* All reads first — Firestore requires it. */
      const [prodSnap, mvSnap] = await Promise.all([t.get(prodRef), t.get(mvRef)]);

      /* Idempotent: a retry returns the original outcome and applies nothing. */
      if (mvSnap.exists) {
        const m = mvSnap.data();
        return { applied: false, idempotent: true, before: m.before, after: m.after,
          inventoryVersion: m.inventoryVersion == null ? null : m.inventoryVersion };
      }

      if (!prodSnap.exists) throw new HttpsError('not-found', 'Product not found.');
      const p = prodSnap.data() || {};

      /* The product must belong to THIS shop. Without this, a merchant could
         adjust another shop's stock by naming their own shopId. */
      if (String(p.shopId || '') !== shopId) {
        throw new HttpsError('permission-denied', 'That product does not belong to this shop.');
      }

      const before = typeof p.stock === 'number' ? p.stock : 0;
      const after = before + delta;

      /* A correction is deliberate, so an impossible result is REFUSED rather
         than floored. (The sale path floors instead, because payment has
         already happened there and the shortfall is flagged, not rejected.) */
      if (after < 0) {
        throw new HttpsError('failed-precondition',
          `That would leave ${after} in stock. There are ${before}; count again or adjust by at most ${before}.`);
      }

      const priorVersion = Number(p.inventoryVersion) || 0;

      /* stock, updatedAt and inventoryVersion move together in ONE write so
         every listener sees a single monotonic change signal — the same
         contract the payment webhook honours.
         `sold` is ABSENT on purpose: a correction is not a sale. */
      t.update(prodRef, {
        stock: after,
        updatedAt: _ts(),
        inventoryVersion: FieldValue.increment(1),
      });

      t.set(mvRef, {
        id: adjustmentId,
        kind: 'adjustment',
        productId,
        productName: p.name || p.title || null,
        shopId,
        sellerUid: uid,
        actorRole: role,
        delta,
        before,
        after,
        inventoryVersion: priorVersion + 1,
        reason,
        note: note || null,
        createdAt: _ts(),
      });

      return { applied: true, idempotent: false, before, after, inventoryVersion: priorVersion + 1 };
    });

    logger.info('[merchantInventory] stock adjusted', {
      productId, shopId, uid, delta, reason,
      applied: result.applied, idempotent: result.idempotent,
    });

    return {
      ok: true,
      productId,
      shopId,
      adjustmentId,
      delta,
      reason,
      before: result.before,
      after: result.after,
      inventoryVersion: result.inventoryVersion,
      idempotent: result.idempotent,
    };
  }
);

exports.REASONS = REASONS;
