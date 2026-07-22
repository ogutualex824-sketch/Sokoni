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

const { onDocumentCreated, onDocumentDeleted, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const F  = admin.firestore.FieldValue;

const REGION  = 'us-central1';
const COUNTER = 'productCounters';

/* ── Limits come from the canonical catalogue ──────────────────────────────
   These constants used to be declared here, which made this file the ELEVENTH
   plan catalogue in a codebase whose defining defect was ten of them. The
   comment above them claimed "declared here and nowhere else" — it was wrong
   when written, because nine others already existed under four different field
   names, and the search that produced it looked for only two of those names.
   That is the whole failure in miniature: a file that believes it is the only
   authority, because it could not see the others.
   Upload authorization is the enforcement point, so it migrates first: whatever
   the dashboard displays, this is what actually stops a merchant publishing. */
const catalog = require('./subscription-catalog');

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

    /* An explicit per-merchant override on the subscription document still
       wins — a negotiated enterprise allowance must not be overwritten by a
       catalogue default. Everything else resolves through the canonical
       catalogue rather than a constant declared here. */
    if (sub && sub.limits && 'maxProducts' in sub.limits) {
      return {
        max: Number(sub.limits.maxProducts),
        status: sub.status || 'unknown',
        source: 'subscription-override',
        catalogVersion: null,
      };
    }

    const ent = catalog.entitlementFor(sub || {});
    return {
      max:            ent.listingLimit,
      status:         ent.subscriptionStatus,
      source:         ent.source,
      catalogVersion: ent.catalogVersion,
    };
  } catch (_) {
    /* Resolution failed. Fall back to the catalogue's FREE allowance rather
       than to unlimited — an error must never hand out a larger entitlement
       than the merchant is owed, and it must never take a shop offline either. */
    const free = catalog.entitlementFor({});
    return {
      max:            free.listingLimit,
      status:         'unresolved',
      source:         free.source,
      catalogVersion: free.catalogVersion,
    };
  }
}

/** Recompute and persist the ceiling. Called after any subscription change. */
async function syncLimit(uid) {
  if (!uid) return null;
  const { max, status, source, catalogVersion } = await resolveMaxProducts(uid);
  /* source and catalogVersion are persisted with the ceiling so a counter can
     be traced to the catalogue generation that produced it. A merchant whose
     limit looks wrong is then a question with an answer — "this was resolved
     from v1 before the change" — rather than another investigation. */
  await db.collection(COUNTER).doc(uid).set(
    { uid, maxProducts: max, status, source: source || null,
      catalogVersion: catalogVersion == null ? null : catalogVersion,
      updatedAt: F.serverTimestamp() },
    { merge: true }
  );
  return { uid, maxProducts: max, status, source, catalogVersion };
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

/**
 * Refresh the materialised ceiling whenever a subscription changes.
 *
 * WHY THIS TRIGGER EXISTS
 * syncLimit was written to keep productCounters.maxProducts in step with the
 * plan, and until now nothing called it — not one caller in the repository. The
 * ceiling was therefore written once, on the merchant's first product, and never
 * revisited. A merchant who upgraded stayed capped at their old allowance until
 * something happened to rewrite the document, which for most of them was never.
 *
 * That is the same defect the catalogue migration addressed, one layer down: the
 * authority was corrected but the cache derived from it had no path to follow.
 *
 * DOCUMENT ID IS NOT THE UID
 * Subscriptions exist under two shapes — subscriptions/{uid} written by
 * payment-reconciliation, and subscriptions/{autoId} with a `uid` field written
 * by sub-engine and sub-billing. Assuming the id is the uid is precisely the
 * mismatch that made a merchant's dashboard report the wrong plan, so the uid is
 * read from the document first and the id used only as a fallback.
 *
 * WHY THE CHANGE IS FILTERED
 * Three other triggers already fire on this collection. Re-syncing on every
 * write — including the timestamp-only writes a renewal produces — would add a
 * transaction per merchant per touch for no change in outcome. Only a plan,
 * status or negotiated-limit change can move the ceiling, so only those re-sync.
 */
exports.onSubscriptionChangedSyncLimit = onDocumentWritten(
  { document: 'subscriptions/{subId}', region: REGION, memory: '256MiB' },
  async (event) => {
    const before = event.data?.before?.data() || null;
    const after  = event.data?.after?.data()  || null;

    /* A deleted subscription still needs a re-sync: the merchant drops to the
       free allowance and the cached ceiling must follow them down. `before` is
       the only remaining source of the uid at that point. */
    const src = after || before;
    if (!src) return;

    const uid = src.uid || event.params.subId;
    if (!uid) return;

    const moved = (a, b) =>
      String(a?.plan   || a?.planId || a?.tier || '') !== String(b?.plan   || b?.planId || b?.tier || '') ||
      String(a?.status || '')                         !== String(b?.status || '')                         ||
      JSON.stringify(a?.limits || null)               !== JSON.stringify(b?.limits || null);

    if (before && after && !moved(before, after)) return;

    try {
      const r = await syncLimit(uid);
      console.log('[product-limit] ceiling re-synced for ' + uid +
                  ' → ' + (r && r.maxProducts) + ' (' + (r && r.status) + ')');
    } catch (e) {
      /* Logged, not rethrown. A failed re-sync leaves the previous ceiling in
         place, which is stale but operable; retrying the trigger would not make
         a resolution error resolve, and productCounters is converged
         independently by scripts/backfill-product-counters.js. */
      console.error('[product-limit] ceiling re-sync FAILED for ' + uid + ': ' + e.message);
    }
  }
);

exports._internal = { resolveMaxProducts, syncLimit, catalog };
