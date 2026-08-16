'use strict';
/**
 * SOKONI Seller Trial — the ONE authority for the 14-day `seller_free` trial.
 *
 * Two legitimate callers, one implementation:
 *
 *     business-bootstrap._createBusiness   (POS onboarding)
 *                    \
 *                     ─→  buildSellerFreeTrial()  ─→  subscriptions/{shopId}
 *                    /
 *     application approval (projectSeller)
 *
 * ── Why extract instead of adding a marketplace trial ──────────────────────
 * The correctly-shaped trial already existed, buried inside `_createBusiness`,
 * reachable only from `pos-setup.html`. Marketplace approval needed the same
 * entitlement, and writing a second one would have produced two subscription
 * models for one product — the exact failure the role and stock work just
 * removed elsewhere. So the block moved here verbatim and `_createBusiness`
 * now calls it.
 *
 * The field set is load-bearing and was hard-won: every expiry mechanism filters
 * on fields the original decorative version did NOT have, so the trial never
 * expired.
 *   • sub-billing.subProcessExpirations reads `currentPeriodEnd.toMillis()`
 *   • sub-engine renewals query `.where('currentPeriodEnd','<=',…)`
 *   • subscription-core.computeStatus needs `trial === true` + `trialEndsAt`
 *   • the expiry notifier reads `users/{uid}` — so `uid` must be present
 * Do not drop a field because it looks redundant; each one is read somewhere.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The subscription is keyed by the SHOP (`subscriptions/{shopId}`) and records
 * the OWNER (`uid`). For POS the shop id is the merchantId, which is what that
 * path already used — so its document id and contents are unchanged.
 *
 * Exports:
 *   TRIAL_DAYS / TRIAL_GRACE_DAYS
 *   buildSellerFreeTrial   pure payload — for callers writing in their own batch
 *   startSellerFreeTrial   idempotent write — for callers without one
 */

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

const TRIAL_DAYS = 14;
const TRIAL_GRACE_DAYS = 3;
const COLLECTION = 'subscriptions';

/**
 * The trial document, exactly as the POS path has always written it.
 *
 * @param {object} o
 *   uid        {string} the owner — the expiry notifier reads users/{uid}
 *   shopId     {string} the shop the entitlement belongs to (POS: merchantId)
 *   planName   {string} surface label ('SmartPOS' for POS, 'SOKONI Seller')
 *   now        {*}      server timestamp sentinel, injected by the caller
 *   nowMs      {number} epoch ms for the boundary arithmetic — a sentinel
 *                       cannot be used in arithmetic, which is why the original
 *                       computed boundaries from Date.now()
 *   source     {string} what created it
 */
function buildSellerFreeTrial(o) {
  if (!o || !o.uid) throw new Error('seller trial: uid is required');
  if (!o.shopId) throw new Error('seller trial: shopId is required');

  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const now = o.now !== undefined ? o.now : FieldValue.serverTimestamp();
  const trialEnd = Timestamp.fromMillis(nowMs + TRIAL_DAYS * 86400000);
  const graceEnd = Timestamp.fromMillis(nowMs + (TRIAL_DAYS + TRIAL_GRACE_DAYS) * 86400000);

  return {
    merchantId: String(o.shopId),
    shopId: String(o.shopId),
    uid: String(o.uid),
    sellerUid: String(o.uid),
    hubType: 'seller',                 // drives the post-trial downgrade to `${hubType}_free`
    planId: 'seller_free',
    planName: o.planName || 'SOKONI Seller',
    plan: 'trial',
    status: 'trialing',
    trial: true,                       // subscription-core.computeStatus gate
    trialDays: TRIAL_DAYS,
    trialStartsAt: now,
    currentPeriodStart: now,
    trialEndsAt: trialEnd,             // subscription-core
    currentPeriodEnd: trialEnd,        // sub-billing sweep + sub-engine renewal query
    graceEnd: graceEnd,
    autoActivated: true,
    source: o.source || 'unknown',
    startedAt: now,
    createdAt: now,
  };
}

/**
 * Start the trial, once. Idempotent: an existing subscription for this shop is
 * left completely alone — a repeat approval (or a repair run) must never
 * restart a trial, reset its dates, or overwrite a PAID plan with a free one.
 *
 * Never throws: a trial is an entitlement, not a gate. Approval has already
 * created the shop and granted the role; failing the whole decision because the
 * subscription write failed would be worse than reporting it.
 *
 * @returns {{created:boolean, reason?:string, shopId:string, trialEndsAt?:*}}
 */
async function startSellerFreeTrial(o) {
  const db = (o && o.db) || getFirestore();
  const uid = o && o.uid;
  const shopId = o && o.shopId;
  if (!uid || !shopId) return { created: false, reason: 'missing_scope', shopId: shopId || null };

  const ref = db.collection(COLLECTION).doc(String(shopId));
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data() || {};
      return { created: false, reason: 'already_subscribed', shopId: String(shopId), planId: d.planId || null, status: d.status || null };
    }
    const doc = buildSellerFreeTrial({
      uid, shopId,
      planName: o.planName || 'SOKONI Seller',
      source: o.source || 'application_approval',
    });
    await ref.set(doc, { merge: false });
    logger.info('[sellerTrial] seller_free trial started', { uid, shopId, trialDays: TRIAL_DAYS });
    return { created: true, shopId: String(shopId), planId: 'seller_free', trialDays: TRIAL_DAYS };
  } catch (e) {
    logger.error('[sellerTrial] could not start trial', { uid, shopId, error: e.message });
    return { created: false, reason: 'error', error: e.message, shopId: String(shopId) };
  }
}

module.exports = { TRIAL_DAYS, TRIAL_GRACE_DAYS, COLLECTION, buildSellerFreeTrial, startSellerFreeTrial };
