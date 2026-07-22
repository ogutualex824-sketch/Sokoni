'use strict';

/**
 * SOKONI Marketplace Product Limit — server-maintained counter.
 *
 * WHY A COUNTER AND NOT A WRITE API
 * Products are created client-side, straight to Firestore (firestore.rules:636).
 * Routing every writer through a new Cloud Function would mean migrating every
 * client that publishes a product, on a platform that is already trading. A
 * counter kept by a trigger leaves those writes exactly as they are while still
 * making the server the authority for the count — and if product creation later
 * moves server-side, the counter is reused rather than replaced.
 *
 * WHY FIRESTORE RULES NEED THE LIMIT MATERIALISED
 * Security rules cannot aggregate — there is no count() in the rules language —
 * so a rule can never work out "how many products does this seller have". It can
 * read ONE document. So both numbers live together in productCounters/{uid}:
 *
 *   { count, maxProducts, status, updatedAt }
 *
 * and the rule becomes a single get(): count < maxProducts. The document is
 * written only by this module (Admin SDK); rules deny all client writes to it,
 * so a seller cannot raise their own ceiling.
 *
 * WHAT IS COUNTED — marketplace listings only
 * Only the `products` collection: the seller's public catalogue. Deliberately
 * NOT posProducts and NOT sellers/{id}/products, which are POS inventory and
 * internal stock. The cap is a commercial limit on how much a merchant may
 * publish, not an operational limit on how much stock they may track — a
 * pharmacy scanning its shelves would otherwise exhaust a 10-item trial in
 * minutes and never get to evaluate the platform.
 *
 * WHAT IS NEVER GATED
 * Edits, deletes, price changes, inventory updates, POS sales and reads. Only
 * the creation of an additional listing. An expired trial must never make a
 * merchant's existing catalogue unreachable.
 */

const { onDocumentCreated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const F  = admin.firestore.FieldValue;

const REGION  = 'us-central1';
const COUNTER = 'productCounters';

/* ── Canonical limits ──────────────────────────────────────────────────────
   Declared here and nowhere else. subscription-core resolves a plan's explicit
   limits.maxProducts when the subscription carries one; these are the fallbacks
   for merchants who have none, which is every merchant on a trial today.
   -1 means unlimited and is the correct value for a paying plan. */
const TRIAL_MAX_PRODUCTS = 10;
const PAID_MAX_PRODUCTS  = -1;

/**
 * Resolve the ceiling for a seller.
 *
 * Reads through subscription-core so the plan catalogue stays the single source
 * of truth: an explicit limits.maxProducts on the plan always wins, and these
 * constants only fill the gap. Failure resolves to the trial limit rather than
 * unlimited — a resolution error must not silently hand out an unlimited
 * catalogue.
 */
async function resolveMaxProducts(uid) {
  try {
    const core = require('./subscription-core');
    const sub  = await core.resolveSubscription(uid, {});
    if (sub && sub.limits && 'maxProducts' in sub.limits) {
      return { max: Number(sub.limits.maxProducts), status: sub.status || 'unknown' };
    }
    const paying = sub && (sub.status === core.STATUS.ACTIVE || sub.status === core.STATUS.GRACE);
    return {
      max:    paying ? PAID_MAX_PRODUCTS : TRIAL_MAX_PRODUCTS,
      status: (sub && sub.status) || 'none',
    };
  } catch (_) {
    return { max: TRIAL_MAX_PRODUCTS, status: 'unresolved' };
  }
}

/** Recompute and persist the ceiling. Called after any subscription change. */
async function syncLimit(uid) {
  if (!uid) return null;
  const { max, status } = await resolveMaxProducts(uid);
  await db.collection(COUNTER).doc(uid).set(
    { uid, maxProducts: max, status, updatedAt: F.serverTimestamp() },
    { merge: true }
  );
  return { uid, maxProducts: max, status };
}

/**
 * Adjust the counter by delta, creating the document on first use.
 *
 * merge:true with an increment is safe on a missing document — Firestore treats
 * the base as zero — so a seller whose first product predates this module still
 * ends up with a correct count rather than a hole. maxProducts is only filled in
 * when absent, so a sync that already ran is never clobbered by a product write.
 */
async function _bump(uid, delta) {
  if (!uid) return;
  const ref = db.collection(COUNTER).doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const patch = { uid, count: F.increment(delta), updatedAt: F.serverTimestamp() };
    if (!snap.exists || typeof snap.data().maxProducts !== 'number') {
      const { max, status } = await resolveMaxProducts(uid);
      patch.maxProducts = max;
      patch.status = status;
    }
    tx.set(ref, patch, { merge: true });
  });
}

/* ── Triggers ─────────────────────────────────────────────────────────────
   Marketplace listings only. A delete decrements so a merchant who removes a
   listing genuinely regains the slot; a cap that only ever counted upward would
   punish tidying up. */
exports.onMarketplaceProductCreated = onDocumentCreated(
  { document: 'products/{productId}', region: REGION },
  async (event) => {
    const d = event.data?.data();
    if (!d || !d.sellerUid) return;
    await _bump(String(d.sellerUid), 1);
  }
);

exports.onMarketplaceProductDeleted = onDocumentDeleted(
  { document: 'products/{productId}', region: REGION },
  async (event) => {
    const d = event.data?.data();
    if (!d || !d.sellerUid) return;
    await _bump(String(d.sellerUid), -1);
  }
);

/* ── Callables ────────────────────────────────────────────────────────────── */

/**
 * canPublishProduct — pre-flight for the client.
 *
 * Advisory only: the rule is what actually stops the write. This exists so the
 * UI can show a real upgrade prompt before the merchant fills in a form, rather
 * than a permission error afterwards.
 */
exports.canPublishProduct = onCall({ region: REGION }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const snap  = await db.collection(COUNTER).doc(uid).get();
  const data  = snap.exists ? snap.data() : {};
  const count = Number(data.count || 0);

  const { max, status } = typeof data.maxProducts === 'number'
    ? { max: data.maxProducts, status: data.status || 'unknown' }
    : await resolveMaxProducts(uid);

  const unlimited = max === -1;
  const allowed   = unlimited || count < max;

  return {
    allowed,
    count,
    limit: max,
    unlimited,
    status,
    remaining: unlimited ? -1 : Math.max(0, max - count),
    /* Structured so the client renders a real message, never a raw error. */
    upgrade: allowed ? null : {
      code:    'PRODUCT_LIMIT_REACHED',
      title:   'Product limit reached',
      message: `You've reached the ${max}-product limit included with your trial. ` +
               'Upgrade your subscription to continue adding products.',
      action:  { label: 'View plans', href: '/subscription.html' },
    },
  };
});

/** Recompute a seller's counter from source. Owner or admin only. */
exports.recountMarketplaceProducts = onCall({ region: REGION }, async (req) => {
  const caller = req.auth?.uid;
  if (!caller) throw new HttpsError('unauthenticated', 'Sign in required.');
  const target = String(req.data?.uid || caller);
  if (target !== caller && !req.auth.token?.admin) {
    throw new HttpsError('permission-denied', 'Cannot recount another seller.');
  }

  const agg = await db.collection('products').where('sellerUid', '==', target).count().get();
  const count = agg.data().count;
  const { max, status } = await resolveMaxProducts(target);

  await db.collection(COUNTER).doc(target).set(
    { uid: target, count, maxProducts: max, status, recountedAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() },
    { merge: true }
  );
  return { uid: target, count, limit: max, status };
});

exports._internal = { resolveMaxProducts, syncLimit, TRIAL_MAX_PRODUCTS, PAID_MAX_PRODUCTS };
