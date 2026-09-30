/* ═══════════════════════════════════════════════════════════════════════════════
   shop-access — ONE answer to "who runs this shop"
   ═══════════════════════════════════════════════════════════════════════════════
   Three server paths now need this question answered: registerPrinterHost, and the two
   print-intent transitions. Three inline copies is how the `posRetailSales` divergence
   happened — one site checking a spelling another site never writes. So it lives here once.

   The check is the one `registerDevice` has always made:

       businesses/{shopId}.ownerId          — the shop owner
       merchants/{shopId}.ownerId           — the merchant owner
       merchants/{shopId}.adminUids[]       — a shop administrator
       posStaff where branchId + uid + active — a cashier on that branch

   It is also the server mirror of the rules' ownsBiz(), so a client read and a server write
   agree about what ownership means.

   NOT CONVERGED YET: `registerDevice` still carries its own inline copy. It is live and this
   is an RC; swapping it out belongs in its own slice with its own proof, not riding along
   inside the print work. Recorded rather than done quietly —
   docs/findings/PWA_PRINTER_HOST_PLAN.md.

   A NOTE ON WHAT THIS IS NOT. It answers "may this user act for this shop". It does NOT
   answer "does this shop own this device" or "does this device host the printer". Those are
   separate facts read from the stored record, and collapsing them into one call is how a
   caller-supplied id starts being treated as ownership.
   ═══════════════════════════════════════════════════════════════════════════════ */
'use strict';

/**
 * Throws HttpsError('permission-denied') unless `uid` may act for `shopId`.
 *
 * @param {object}   o
 * @param {FirebaseFirestore.Firestore} o.db
 * @param {string}   o.uid       caller
 * @param {string}   o.shopId    the shop, ALREADY established from a stored record where the
 *                               operation has one — never taken from the request as proof
 * @param {?string}  o.branchId  enables the posStaff path when present
 * @param {boolean}  o.isAdmin   platform admin bypass
 * @param {Function} o.HttpsError
 * @param {string}  [o.message]
 */
async function assertShopAccess (o) {
  const { db, uid, shopId, branchId, isAdmin, HttpsError } = o;
  if (isAdmin) return { via: 'admin' };
  if (!uid)    throw new HttpsError('unauthenticated', 'Sign in first.');
  if (!shopId) throw new HttpsError('failed-precondition', 'No shop on that record.');

  const [bizSnap, merchantSnap, staffSnap] = await Promise.all([
    db.collection('businesses').doc(shopId).get(),
    db.collection('merchants').doc(shopId).get(),
    branchId
      ? db.collection('posStaff')
          .where('branchId', '==', branchId)
          .where('uid', '==', uid)
          .where('status', '==', 'active')
          .limit(1)
          .get()
      : Promise.resolve({ empty: true }),
  ]);

  if (bizSnap.exists && bizSnap.data().ownerId === uid) return { via: 'businessOwner' };
  if (merchantSnap.exists) {
    const m = merchantSnap.data();
    if (m.ownerId === uid) return { via: 'merchantOwner' };
    if (Array.isArray(m.adminUids) && m.adminUids.includes(uid)) return { via: 'shopAdmin' };
  }
  if (!staffSnap.empty) return { via: 'posStaff' };

  throw new HttpsError('permission-denied',
    o.message || 'You do not have permission to act for this shop.');
}

module.exports = { assertShopAccess };
