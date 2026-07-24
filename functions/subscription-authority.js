/* ============================================================================
   SubscriptionAuthority — the ONE place merchant entitlements are decided.

   WHY THIS EXISTS (production incident, 2026-07-24)
   A merchant on a paid STARTER plan saw a 10-product limit in the UI while the
   upload engine accepted 13 products. Neither number was a bug on its own —
   they came from two different systems that never met:

     webhookIntasend  --writes-->  subscriptions/{uid}
                                        |
                                        +--> subscription-core.resolveSubscription
                                        +--> subscription-catalog (STARTER = 100)
                                        +--> canPublishProduct  => 13 allowed  CORRECT

     sub-billing.js   --writes-->  users/{uid}.subscription.{hubType}
                                        |
                                        +--> sokoni-subscription.js (client)
                                        +--> no document => FREE_DEFAULTS = 10  WRONG

   The IntaSend webhook activates the first path and never touches the second,
   so the client read a document that was never written and fell back to its
   hard-coded free allowance. The upload guard was right; the display was
   reading a different authority.

   Ten separate limit tables existed across the repository
   (`scripts/verify-listing-limit-single-source.js` lists them). This module does
   not add an eleventh: it resolves through subscription-catalog, the declared
   canonical catalogue, and every consumer reads the result rather than
   recomputing it.

   CONTRACT — the only shape a caller should depend on:
     { active, plan, uploadLimit, uploadsUsed, uploadsRemaining, premium, expiresAt }

   `uploadLimit: -1` means unlimited, everywhere, always. `uploadsRemaining` is
   -1 when unlimited so a caller never has to special-case a negative subtraction.
============================================================================ */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const db = () => admin.firestore();

const catalog = require('./subscription-catalog');

/* The hub the marketplace seller UI reads. sokoni-subscription.js defaults to
   'seller' (init(hubType) → _hubType = hubType || 'seller'), and sub-billing.js
   writes users/{uid}.subscription.<hubType>. Mirroring under the same key is
   what makes an existing screen correct itself without being rewritten. */
const SELLER_HUB = 'seller';

/**
 * How many products the merchant currently holds.
 *
 * productCounters/{uid}.count is maintained by product-limit.js's create/delete
 * triggers and is the cheap path. A missing counter means the merchant predates
 * the counter or it was never materialised — fall back to an aggregate count
 * rather than reporting zero, because reporting zero would tell a merchant who
 * is over their limit that they have their whole allowance free.
 */
async function _uploadsUsed(uid) {
  try {
    const snap = await db().collection('productCounters').doc(uid).get();
    if (snap.exists && typeof snap.data().count === 'number') {
      return { used: Number(snap.data().count), source: 'productCounters' };
    }
  } catch (_) { /* fall through to the aggregate */ }

  try {
    const agg = await db().collection('products').where('sellerId', '==', uid).count().get();
    return { used: Number(agg.data().count || 0), source: 'aggregate-count' };
  } catch (_) {
    return { used: 0, source: 'unavailable' };
  }
}

/**
 * resolveEntitlements(uid) — the single decision.
 *
 * Never throws: an entitlement resolution failure must not take a shop offline,
 * and must never hand out a LARGER allowance than the merchant is owed. On any
 * failure this returns the catalogue's FREE allowance, which is the same rule
 * product-limit.js already applies.
 */
async function resolveEntitlements(uid) {
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required');

  let sub = null;
  try {
    const core = require('./subscription-core');
    sub = await core.resolveSubscription(uid, {});
  } catch (_) { sub = null; }

  const ent = catalog.entitlementFor(sub || {});

  /* A negotiated per-merchant override on the subscription document still wins.
     product-limit.js honours the same field; if it did not agree here the two
     would disagree for exactly the merchants most likely to notice. */
  let uploadLimit = ent.listingLimit;
  let limitSource = 'catalog';
  if (sub && sub.limits && 'maxProducts' in sub.limits) {
    uploadLimit = Number(sub.limits.maxProducts);
    limitSource = 'subscription-override';
  }

  const { used, source: usedSource } = await _uploadsUsed(uid);
  const unlimited = uploadLimit === -1;
  const active    = ent.subscriptionStatus !== 'INACTIVE';

  return {
    /* ── the contract ── */
    active,
    plan:             ent.plan,
    uploadLimit,
    uploadsUsed:      used,
    uploadsRemaining: unlimited ? -1 : Math.max(0, uploadLimit - used),
    premium:          active && ent.plan !== 'FREE',
    expiresAt:        (sub && (sub.expiresAt || sub.currentPeriodEnd)) || null,

    /* ── provenance, for diagnostics and the audit log ── */
    _meta: {
      status: ent.subscriptionStatus,
      label: ent.label,
      limitSource,
      usedSource,
      catalogVersion: ent.catalogVersion || null,
      resolvedAt: new Date().toISOString(),
    },
  };
}

/**
 * materialiseEntitlements(uid) — persist the decision so every reader agrees.
 *
 * Writes two places on purpose:
 *
 *   entitlements/{uid}                      the canonical materialised record;
 *                                           new consumers read this
 *   users/{uid}.subscription.seller         the document the EXISTING client
 *                                           (sokoni-subscription.js) already
 *                                           listens to
 *
 * The mirror is what repairs the reported symptom without rewriting every
 * screen: the client's onSnapshot fires, subData stops being null, and the UI
 * stops falling back to FREE_DEFAULTS. It is a compatibility bridge, not a
 * second source of truth — both values are computed here, in one place.
 *
 * Never throws. A materialisation failure must not fail the payment webhook
 * that calls it: the subscription is already active and authoritative in
 * subscriptions/{uid}, and this can be recomputed at any time.
 */
async function materialiseEntitlements(uid, reason = 'unspecified') {
  try {
    const ent = await resolveEntitlements(uid);
    const now = admin.firestore.FieldValue.serverTimestamp();

    await db().collection('entitlements').doc(uid).set({
      uid,
      active:           ent.active,
      plan:             ent.plan,
      uploadLimit:      ent.uploadLimit,
      uploadsUsed:      ent.uploadsUsed,
      uploadsRemaining: ent.uploadsRemaining,
      premium:          ent.premium,
      expiresAt:        ent.expiresAt || null,
      meta:             ent._meta,
      reason,
      updatedAt:        now,
    }, { merge: true });

    /* Compatibility mirror. Field-path form so it merges into the existing
       subscription map rather than replacing a sibling hub. `features` carries
       the key the legacy client asks for by name (quota('listings_limit')). */
    await db().collection('users').doc(uid).set({
      [`subscription.${SELLER_HUB}`]: {
        planId:    ent.plan,
        tier:      ent.plan,
        status:    ent.active ? String(ent._meta.status || 'ACTIVE').toLowerCase() : 'inactive',
        features:  { listings_limit: ent.uploadLimit },
        expiresAt: ent.expiresAt || null,
        updatedAt: now,
        source:    'subscription-authority',
      },
    }, { merge: true });

    await db().collection('entitlementAuditLog').add({
      uid, reason,
      plan: ent.plan,
      uploadLimit: ent.uploadLimit,
      uploadsUsed: ent.uploadsUsed,
      active: ent.active,
      meta: ent._meta,
      timestamp: now,
    });

    return ent;
  } catch (e) {
    console.error('[subscription-authority] materialise failed', { uid, reason, err: e.message });
    return null;
  }
}

/* ── Public callable — every screen consumes THIS ─────────────────────────── */
exports.getMerchantEntitlements = onCall(
  { region: REGION, enforceAppCheck: true },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

    /* A merchant may only read their own entitlements. An admin may read any,
       because support has to answer "what does this merchant actually have?" —
       the question that took a production investigation to answer once. */
    const target = String((req.data && req.data.uid) || req.auth.uid);
    const isSelf = target === req.auth.uid;
    const isAdmin = !!(req.auth.token && (req.auth.token.admin || req.auth.token.superAdmin));
    if (!isSelf && !isAdmin) throw new HttpsError('permission-denied', 'Not your entitlements.');

    const ent = await resolveEntitlements(target);
    return {
      active:           ent.active,
      plan:             ent.plan,
      uploadLimit:      ent.uploadLimit,
      uploadsUsed:      ent.uploadsUsed,
      uploadsRemaining: ent.uploadsRemaining,
      premium:          ent.premium,
      expiresAt:        ent.expiresAt,
    };
  }
);

/* Recompute whenever the authoritative subscription document changes, so the
   materialised record and the mirror cannot lag behind a plan change made by
   any path — webhook, admin action, expiry sweep or manual repair. */
exports.onSubscriptionChangedSyncEntitlements = require('firebase-functions/v2/firestore')
  .onDocumentWritten(
    { document: 'subscriptions/{subId}', region: REGION, memory: '256MiB' },
    async (event) => {
      const after = event.data && event.data.after && event.data.after.data();
      const before = event.data && event.data.before && event.data.before.data();
      const uid = (after && after.uid) || (before && before.uid) || event.params.subId;
      if (!uid) return;
      await materialiseEntitlements(uid, 'subscription-changed');
    }
  );

exports._internal = { resolveEntitlements, materialiseEntitlements, SELLER_HUB };
