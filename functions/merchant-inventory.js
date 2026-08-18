'use strict';
/**
 * SOKONI Merchant Inventory — the ONE authority for a stock CORRECTION.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Two things change canonical `products.stock`, and they mean different things:
 *
 *   A SALE        posCompleteCheckout  → stock down, sale recorded, money moves
 *   A CORRECTION  here                 → stock moves, movement recorded, NO sale
 *
 * On this branch there is no server authority for the second one. The only
 * client path is `PosDB.products.adjustStock()`, which writes IndexedDB first
 * and then pushes the delta to canonical `products.stock` "best-effort,
 * online-only" — so the phone shows a number that the server may never have
 * agreed to. A merchant counting damaged stock off the shelf offline sees the
 * correction applied and has no way to learn it was never persisted.
 *
 * `inventoryAdjustStock` (inventory-engine.js) is NOT that authority either. It
 * writes `tenants/{id}/inventory_levels|movements|products` — the enterprise
 * warehouse model, a different counter from the one POS deducts and the
 * catalogue reads. Routing corrections there would give one shelf two numbers.
 *
 * So this is the FIRST authority over corrections to canonical
 * `products.stock`, not a second one. It is deliberately narrow.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *   sale        → posCompleteCheckout → stock ↓ → sale recorded → sold ↑
 *   correction  → merchantAdjustStock → stock ⇅ → movement      → sold UNCHANGED
 *
 * `products.sold` is never read, written, incremented or defaulted here. A
 * correction is not a sale and must never look like one in any aggregate.
 *
 * ── Authorisation (reconciled for THIS branch) ──────────────────────────────
 * Ownership is `products/{id}.sellerUid === uid`, or a platform admin claim.
 * That is exactly the invariant firestore.rules already enforces for a direct
 * product update, so this callable is never weaker than the rule it bypasses.
 *
 * It deliberately does NOT reuse analytics-engine's `_assertShop`. That helper
 * grants access when `shopEmployees/{shopId}_{uid}` merely EXISTS, and
 * firestore.rules allows any authenticated client to create a shopEmployees
 * document whose payload names itself (`shopOwnerId == request.auth.uid`).
 * Believing such a record is a privilege-escalation path. It is pre-existing on
 * read-only analytics; it must not be extended to a surface that MUTATES stock.
 * Employee delegation can be added later on top of a verified contract — the
 * narrow owner/admin rule loses nothing that currently works.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * The caller supplies `adjustmentId`. The movement document is claimed under
 * that id INSIDE the transaction, so a double tap, a retried call, or a
 * duplicated network attempt applies the delta exactly once and returns the
 * original result rather than moving stock twice.
 *
 * Exports (must be re-exported by name from functions/index.js):
 *   merchantAdjustStock   onCall — the sole canonical stock-correction path
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const admin  = require('firebase-admin');
const logger = require('firebase-functions/logger');

const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();

/* Why the stock moved. A correction without a stated reason is an unexplained
   inventory change, which is exactly what an audit cannot work with. */
const REASONS = Object.freeze([
  'count_correction', 'damage', 'theft', 'expiry',
  'restock', 'return_to_supplier', 'transfer', 'other',
]);

/* A delta larger than this is a fat-finger or a unit mix-up, not a correction. */
const MAX_DELTA = 1000000;

const _san = (v, n = 200) =>
  String(v == null ? '' : v).slice(0, n).replace(/[<>"]/g, '').trim();

async function _isPlatformAdmin (uid) {
  try {
    const claims = (await admin.auth().getUser(uid)).customClaims || {};
    return claims.role === 'admin' || claims.role === 'superAdmin';
  } catch (_) {
    return false;
  }
}

exports.merchantAdjustStock = onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to adjust stock.');

    const d = req.data || {};
    const productId    = _san(d.productId, 128);
    const shopId       = _san(d.shopId, 128);
    const adjustmentId = _san(d.adjustmentId, 128);
    const reason       = _san(d.reason, 40);
    const note         = _san(d.note, 200);
    const delta        = Number(d.delta);

    if (!productId)    throw new HttpsError('invalid-argument', 'productId is required.');
    if (!shopId)       throw new HttpsError('invalid-argument', 'shopId is required.');
    /* Mandatory, not generated here: the id must survive a retry from the SAME
       client attempt, so only the caller can supply it. */
    if (!adjustmentId) throw new HttpsError('invalid-argument', 'adjustmentId is required (it makes the adjustment idempotent).');
    if (!Number.isInteger(delta) || delta === 0)
      throw new HttpsError('invalid-argument', 'delta must be a non-zero whole number.');
    if (Math.abs(delta) > MAX_DELTA)
      throw new HttpsError('invalid-argument', 'delta is implausibly large.');
    if (!REASONS.includes(reason))
      throw new HttpsError('invalid-argument', `reason must be one of: ${REASONS.join(', ')}.`);

    const db       = _db();
    const prodRef  = db.collection('products').doc(productId);
    const mvRef    = db.collection('stockMovements').doc(adjustmentId);
    const isAdmin  = await _isPlatformAdmin(uid);

    const result = await db.runTransaction(async (t) => {
      /* Idempotency is claimed INSIDE the transaction. A replay returns the
         original outcome and performs no second mutation. */
      const mvSnap = await t.get(mvRef);
      if (mvSnap.exists) {
        const m = mvSnap.data() || {};
        return {
          idempotent: true,
          before: m.before ?? null,
          after:  m.after  ?? null,
          inventoryVersion: m.inventoryVersion ?? null,
        };
      }

      const prodSnap = await t.get(prodRef);
      if (!prodSnap.exists) throw new HttpsError('not-found', 'Product not found.');
      const p = prodSnap.data() || {};

      /* Ownership. `sellerUid` is the field firestore.rules gates product
         updates on, so this callable enforces the same owner invariant rather
         than a weaker one. A caller may not adjust another seller's stock by
         naming their own shopId. */
      if (!isAdmin && p.sellerUid !== uid)
        throw new HttpsError('permission-denied', 'That product does not belong to this seller.');

      /* The caller's asserted scope must agree with the product's own, when the
         product carries one. Prevents a correct owner writing a movement filed
         under the wrong shop. */
      const prodShop = p.shopId || p.merchantId || null;
      if (prodShop && shopId && String(prodShop) !== String(shopId))
        throw new HttpsError('permission-denied', 'That product does not belong to this shop.');

      const before = typeof p.stock === 'number' ? p.stock : 0;
      const after  = before + delta;
      /* Floored at zero, never negative — the same floor posCompleteCheckout
         applies. A correction that would go below zero is a miscount, and
         silently wrapping it negative corrupts every downstream aggregate. */
      if (after < 0)
        throw new HttpsError('failed-precondition',
          `Insufficient stock: ${before} on hand, ${Math.abs(delta)} removed.`);

      const nextVersion = (typeof p.inventoryVersion === 'number' ? p.inventoryVersion : 0) + 1;

      /* stock + updatedAt + inventoryVersion move TOGETHER, atomically, so a
         client cache can never see a new quantity at an old version.
         `sold` is deliberately absent. */
      t.update(prodRef, {
        stock:            after,
        inventoryVersion: nextVersion,
        updatedAt:        _ts(),
      });

      t.set(mvRef, {
        adjustmentId,
        productId,
        productName: p.name || null,
        shopId:      shopId || prodShop || null,
        sellerUid:   p.sellerUid || null,
        type:        delta > 0 ? 'in' : 'out',
        delta,
        qty:         Math.abs(delta),
        before,
        after,
        inventoryVersion: nextVersion,
        reason,
        note:        note || null,
        source:      'merchantAdjustStock',
        actorUid:    uid,
        actorIsAdmin: isAdmin,
        createdAt:   _ts(),
      });

      return { idempotent: false, before, after, inventoryVersion: nextVersion };
    });

    logger.info('[merchantAdjustStock]', {
      uid, productId, shopId, adjustmentId, delta, reason,
      idempotent: result.idempotent, before: result.before, after: result.after,
    });

    return { ok: true, ...result };
  }
);

/* Exported for unit tests — the validation surface, not the transaction. */
exports._REASONS   = REASONS;
exports._MAX_DELTA = MAX_DELTA;
exports._san       = _san;
