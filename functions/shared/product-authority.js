'use strict';
/**
 * SOKONI — product write authority (the server-side ownership predicate).
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * `products` writes made through the Admin SDK BYPASS firestore.rules entirely.
 * The rules layer correctly enforces `sellerUid == request.auth.uid` on
 * create/update/delete, but a callable that writes with admin credentials never
 * consults it. A Stage E0 census of every server-side product mutation found two
 * paths where that mattered:
 *
 *   posSyncToMarketplace  — only checked `request.auth` existed, then decremented
 *                           `stock` on a CLIENT-SUPPLIED productId. Any signed-in
 *                           account could alter any seller's inventory.
 *   cycleCountComplete    — bounded the caller to a shop, but never proved the
 *                           counted productIds belonged to that shop.
 *
 * One predicate, not a copy per module: the divergence between `_assertPOS`,
 * `_ownerOrAdmin` and `_requireRole` is precisely how those two paths came to
 * disagree about what authority means.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It does not decide whether the caller is an approved SELLER. That is the
 * separate seller-approval gate; this module answers only "does this account own
 * these products". Adding the approval check here before that gate exists would
 * deny the one operational merchant, whose authority today is ownership.
 */

const { HttpsError } = require('firebase-functions/v2/https');

/* Platform-elevated callers. Mirrors the existing `_isElevated` in
   pos-marketplace-sync.js rather than inventing a fourth spelling. */
function isElevated(auth) {
  const t = (auth && auth.token) || {};
  const r = t.role;
  return t.admin === true || t.superAdmin === true
      || r === 'admin' || r === 'super_admin' || r === 4 || r === 5;
}

/**
 * The seller a shop belongs to, read from the LIVE model.
 *
 * NOT `ownerId`. No shop document carries that field — ownership is `sellerUid`
 * and `uid`, and the document id is itself the owner uid (measured 2026-08-17
 * against production). `_assertPOS` tests `shop.ownerId`, so its owner branch is
 * dead; that is a separate finding and is deliberately NOT repaired here, because
 * silently changing who can reach a POS handler is not part of closing an
 * ownership hole.
 */
function shopSellerUidFrom(shop, shopId) {
  const s = shop || {};
  return s.sellerUid || s.uid || shopId || null;
}

async function shopSellerUid(db, shopId) {
  if (!shopId) return null;
  const snap = await db.collection('shops').doc(String(shopId)).get();
  if (!snap.exists) return null;
  return shopSellerUidFrom(snap.data(), snap.id);
}

/**
 * Resolve every productId and prove each belongs to `sellerUid`.
 *
 * Throws on the FIRST ownership violation and BEFORE the caller commits anything,
 * so a batch containing one foreign product applies none of its writes. Partial
 * application is the failure mode this exists to prevent.
 *
 * Missing products are returned rather than thrown, because a POS basket may
 * legitimately contain an item that was never listed on the marketplace — the
 * callers already skip those, and this preserves that behaviour exactly.
 *
 * Returns { found: Map<id, snapshot>, missing: string[] }.
 */
async function resolveOwnedProducts(db, productIds, sellerUid, opts) {
  const o = opts || {};
  const ids = [...new Set((productIds || []).map((x) => (x == null ? '' : String(x))).filter(Boolean))];
  const found = new Map();
  const missing = [];
  if (!ids.length) return { found, missing };

  /* A caller with no resolvable seller identity owns nothing. Refusing here stops
     `undefined === undefined` from reading as ownership. */
  if (!o.elevated && !sellerUid) {
    throw new HttpsError('permission-denied', 'Caller has no seller identity for product writes.');
  }

  const refs = ids.map((id) => db.collection('products').doc(id));
  const snaps = await db.getAll(...refs);

  for (const snap of snaps) {
    if (!snap.exists) { missing.push(snap.id); continue; }
    const owner = (snap.data() || {}).sellerUid || null;
    if (!o.elevated && owner !== sellerUid) {
      /* Deliberately does not echo the real owner back to the caller. */
      throw new HttpsError('permission-denied',
        'Product ' + snap.id + ' does not belong to this seller.');
    }
    found.set(snap.id, snap);
  }
  return { found, missing };
}

module.exports = { isElevated, shopSellerUid, shopSellerUidFrom, resolveOwnedProducts };
