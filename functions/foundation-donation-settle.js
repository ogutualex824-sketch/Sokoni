'use strict';
/**
 * SOKONI Foundation — the ONE completion writer for a donation (owner, 2026-10-01).
 *
 * A donation is a PLEDGE (foundationDonations/{PLG_<uid>_<requestId> | CHK_<orderId>}, status 'pledged', no ledger)
 * paid through ITS OWN intent (createPaymentIntent purpose 'donation', ref DON_<pledgeId>). This module is called by
 * webhookIntasend for that intent, in isolation — it never reaches wallet, commission or order code.
 *
 *   verified COMPLETE, KES, GROSS == pledge amount == intent amount
 *       → ONE transaction: pledge 'completed' (+ receiptId, completedAt, providerReference, gross/fee/net, intentRef);
 *         impactLedger credit (gross) + fee debit (IntaSend charges), create-once on the provider reference;
 *         impactBalance (net effect = what actually arrived); foundationStats; the programme's raised (+gross) /
 *         donors (+1). Replay → no-op.
 *   anything else on a COMPLETE   → pledge 'review' (+ reason), NO credit.
 *   FAILED / CANCELLED / EXPIRED … → pledge 'failed', NO credit.
 *
 * Field names agreed with sokoni-4d (impactGetMyPledge reads status / receiptId / completedAt). The ledger rows match
 * impact.js _writeLedgerEntry's schema (type, debit, credit, balanceBefore/After, uid, campaignId, paymentRef, …).
 */

/** Is this payment a donation? Reads the server-minted intent. @returns intent data | null. Throws on a read error. */
async function _donationIntent(db, apiRef, intentRef) {
  const s = await db.collection('paymentIntents').doc(String(intentRef || apiRef)).get();
  if (!s.exists) return null;
  const i = s.data() || {};
  if (i.purpose !== 'donation' || i.resourceType !== 'foundationDonation' || !i.resourceId) return null;
  return i;
}

/**
 * @param o { apiRef, intentRef, state, gross, net, charges, currency, providerRef }
 * @returns {Promise<false | {outcome:string}>} false = not a donation (caller continues); otherwise handled.
 */
async function settleDonationPayment(db, admin, o) {
  const FV = admin.firestore.FieldValue;
  let intent;
  try { intent = await _donationIntent(db, o.apiRef, o.intentRef); }
  catch (e) {
    /* Cannot tell. NOT a donation decision: the caller's generic path withholds every credit on an unreadable
       intent (fail closed), and the pledge simply stays 'pledged' — never credited unverified. */
    console.error('[donation] intent unreadable — not settled here:', o.apiRef, e && e.message);
    return false;
  }
  if (!intent) return false;

  const pledgeId = String(intent.resourceId);
  const pRef = db.collection('foundationDonations').doc(pledgeId);
  const state = String(o.state || '').toUpperCase();
  const now = Date.now();

  /* ── terminal non-payment → 'failed', no credit ── */
  if (state !== 'COMPLETE') {
    if (!['FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'TIMEOUT'].includes(state)) return { outcome: 'pending' };
    await db.runTransaction(async (t) => {
      const ps = await t.get(pRef);
      if (!ps.exists || ps.data().status !== 'pledged') return;
      t.update(pRef, { status: 'failed', failedAt: now, failureState: state, intentRef: String(o.intentRef || o.apiRef), updatedAt: FV.serverTimestamp() });
    });
    await db.collection('paymentIntents').doc(String(o.intentRef || o.apiRef)).set({ status: 'failed', updatedAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
    return { outcome: 'failed' };
  }

  const gross = Number(o.gross);
  const charges = Number.isFinite(Number(o.charges)) ? Math.max(0, Number(o.charges)) : Math.max(0, gross - Number(o.net || 0));
  const net = Number.isFinite(Number(o.net)) && Number(o.net) > 0 ? Number(o.net) : gross - charges;
  const providerRef = String(o.providerRef || o.apiRef);
  const ledgerRef = db.collection('impactLedger').doc('DON_' + providerRef.replace(/[^A-Za-z0-9_-]/g, '_'));
  const feeRef    = db.collection('impactLedger').doc('DONFEE_' + providerRef.replace(/[^A-Za-z0-9_-]/g, '_'));
  const balRef    = db.collection('impactBalance').doc('current');
  const statsRef  = db.collection('foundationStats').doc('current');

  const res = await db.runTransaction(async (t) => {
    /* ALL reads first */
    const ps = await t.get(pRef);
    const ls = await t.get(ledgerRef);
    if (!ps.exists) return { outcome: 'no-pledge' };
    const p = ps.data() || {};
    if (ls.exists || p.status === 'completed') return { outcome: 'replay' };            /* idempotent */
    if (p.status !== 'pledged') return { outcome: 'not-pledged', status: p.status };
    const progRef = p.programmeId ? db.collection('impactCampaigns').doc(String(p.programmeId)) : null;
    const prog = progRef ? await t.get(progRef) : null;
    const bal = await t.get(balRef);

    /* exact evidence: KES, gross == pledge == intent */
    const pledgeKES = Number(p.amount);
    const why = String(o.currency || 'KES').toUpperCase() !== 'KES' ? 'currency_not_kes'
      : (p.currency && p.currency !== 'KES') ? 'pledge_currency_not_kes'
      : !(Number.isFinite(gross) && gross > 0) ? 'no_gross_evidence'
      : Math.round(gross * 100) !== Math.round(pledgeKES * 100) ? 'gross_mismatch'
      : Math.round(Number(intent.amount) * 100) !== Math.round(pledgeKES * 100) ? 'intent_mismatch'
      : (intent.uid && p.uid && intent.uid !== p.uid) ? 'owner_mismatch' : null;
    if (why) {
      t.update(pRef, { status: 'review', reviewReason: why, reviewGrossKES: Number.isFinite(gross) ? gross : null,
        providerReference: providerRef, intentRef: String(o.intentRef || o.apiRef), updatedAt: FV.serverTimestamp() });
      return { outcome: 'review', reason: why };
    }

    const prev = bal.exists ? (Number(bal.data().balance) || 0) : 0;
    const afterCredit = prev + gross, afterFee = afterCredit - charges;
    const receiptId = 'SKF-' + providerRef;
    const inactive = !!(prog && prog.exists && prog.data().status && prog.data().status !== 'active');
    t.update(pRef, {
      status: 'completed', receiptId, completedAt: now, providerReference: providerRef,
      grossKES: gross, feeKES: charges, netKES: net, intentRef: String(o.intentRef || o.apiRef),
      ...(inactive ? { campaignInactiveAtCompletion: true } : {}), updatedAt: FV.serverTimestamp(),
    });
    t.create(ledgerRef, { type: 'donation', debit: 0, credit: gross, balanceBefore: prev, balanceAfter: afterCredit,
      uid: p.uid || null, campaignId: p.programmeId || null, orderId: p.orderId || null, paymentRef: providerRef,
      description: 'Donation ' + receiptId + (p.programmeId ? ' — programme ' + p.programmeId : ''),
      meta: { pledgeId, receiptId, purpose: p.purpose || null, anonymous: p.anonymous === true }, status: 'completed', createdAt: FV.serverTimestamp() });
    if (charges > 0) {
      t.create(feeRef, { type: 'fee', debit: charges, credit: 0, balanceBefore: afterCredit, balanceAfter: afterFee,
        uid: null, campaignId: p.programmeId || null, orderId: null, paymentRef: providerRef,
        description: 'IntaSend charges on ' + receiptId, meta: { pledgeId, receiptId }, status: 'completed', createdAt: FV.serverTimestamp() });
    }
    /* verifiedBalance (sokoni-4d, 2026-10-01): the ONLY money Foundation payouts may spend — IntaSend-confirmed net.
       Disbursement / refund code decrements it; available = verifiedBalance − reservedKES; a missing field = 0 = payouts
       blocked (fail closed). Written ONLY here, in the same transaction as the credit it reflects. */
    t.set(balRef, { balance: afterFee, verifiedBalance: FV.increment(gross - charges), totalReceived: FV.increment(gross), totalFees: FV.increment(charges), lastUpdated: FV.serverTimestamp() }, { merge: true });
    t.set(statsRef, { totalDonations: FV.increment(gross), donationsCount: FV.increment(1), updatedAt: FV.serverTimestamp() }, { merge: true });
    if (prog && prog.exists) t.set(progRef, { raised: FV.increment(gross), donors: FV.increment(1), updatedAt: FV.serverTimestamp() }, { merge: true });
    return { outcome: 'completed', receiptId, inactive };
  });
  if (res.outcome === 'completed') {
    await db.collection('paymentIntents').doc(String(o.intentRef || o.apiRef)).set({ status: 'paid', paidRef: o.apiRef, paidAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
  }
  console.log('[donation] ' + o.apiRef + ' → ' + res.outcome + (res.reason ? ' (' + res.reason + ')' : ''));
  return res;
}

module.exports = { settleDonationPayment, _donationIntent };
