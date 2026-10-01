'use strict';
/**
 * Financial partner plans + promotion purchases — the webhook settlement (owner, 2026-10-01; sokoni-4d's domain).
 *
 * Called by webhookIntasend for a 'partner_subscription' / 'promotion_purchase' intent, in isolation — it never
 * reaches wallet, commission or order code. The ENTITLEMENT is written only by commercial-entitlements.js
 * (fulfilPartnerSubscription / fulfilPromotion, ported byte-identical from 764cb66), inside one transaction:
 *   · the amount handed to it is the GROSS IntaSend confirmed (invoice.value), not the intent's — the handler
 *     re-checks it against the authoritative price, so a short payment can never buy a plan;
 *   · currency must be KES and the payer must be the intent's owner, else the purchase is held for review here;
 *   · idempotent on the intent ref (commercialFulfilments/{ref} create-once) — a replayed or concurrent callback
 *     has exactly one effect;
 *   · FAILED / CANCELLED / EXPIRED → the intent is marked failed; nothing is granted.
 */
const PURPOSES = ['partner_subscription', 'promotion_purchase'];

async function settleCommercialPayment(db, admin, o) {
  const FV = admin.firestore.FieldValue, TS = admin.firestore.Timestamp;
  const iRef = db.collection('paymentIntents').doc(String(o.intentRef || o.apiRef));
  let intent;
  try { const s = await iRef.get(); intent = s.exists ? s.data() : null; }
  catch (e) { console.error('[commercial] intent unreadable — not settled here:', o.apiRef, e && e.message); return false; }
  if (!intent || !PURPOSES.includes(intent.purpose)) return false;

  const state = String(o.state || '').toUpperCase();
  if (state !== 'COMPLETE') {
    if (!['FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'TIMEOUT'].includes(state)) return { outcome: 'pending' };
    await iRef.set({ status: 'failed', failureState: state, updatedAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
    return { outcome: 'failed' };
  }
  const ref = String(o.intentRef || o.apiRef);
  const gross = Number(o.gross);
  const why = String(o.currency || 'KES').toUpperCase() !== 'KES' ? 'currency_not_kes'
    : !(Number.isFinite(gross) && gross > 0) ? 'no_gross_evidence'
    : (o.payerUid && intent.uid && String(o.payerUid) !== String(intent.uid)) ? 'payer_not_owner' : null;
  if (why) {
    await db.runTransaction(async (t) => {
      const r = db.collection('commercialFulfilments').doc(ref);
      if ((await t.get(r)).exists) return;
      t.create(r, { domain: intent.purpose === 'partner_subscription' ? 'partner' : 'promotion', ownerId: intent.uid || null,
        intentRef: ref, outcome: 'review', reason: why, amountKES: Number.isFinite(gross) ? gross : null, at: FV.serverTimestamp() });
    });
    await iRef.set({ status: 'review', reviewReason: why, updatedAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
    return { outcome: 'review', reason: why };
  }
  const CE = require('./commercial-entitlements');
  const fulfil = intent.purpose === 'partner_subscription' ? CE.fulfilPartnerSubscription : CE.fulfilPromotion;
  const meta = (intent.metadata && intent.metadata.ceMeta) || {};
  const res = await db.runTransaction((tx) => fulfil(tx, { ref, uid: intent.uid, amountKES: gross, meta },
    { db, FieldValue: FV, Timestamp: TS, now: Date.now() }));
  const outcome = res.already ? 'replay' : res.fulfilled ? 'fulfilled' : 'review';
  if (outcome !== 'replay') {
    await iRef.set({ status: outcome === 'fulfilled' ? 'paid' : 'review', paidRef: o.apiRef, updatedAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
  }
  console.log('[commercial] ' + o.apiRef + ' (' + intent.purpose + ') → ' + outcome);
  return Object.assign({ outcome }, res);
}

module.exports = { settleCommercialPayment, PURPOSES };
