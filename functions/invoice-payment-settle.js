'use strict';
/**
 * Invoice payments — the webhook half of the canonical invoice contract (owner 2026-10-04; intent: 2f 549ba7f,
 * allocation: f3 7bd9c55). Called by webhookIntasend AFTER the payment is recorded COMPLETE.
 *
 *   invoice → payment initiation (2f: amount = the server-read balance, 15% snapshot captured) → VERIFIED webhook
 *   → allocation (f3: one per payment; applied ≤ balance; excess HELD) → 15% on the APPLIED amount (the snapshot,
 *   never today's table) → merchant BUSINESS wallet (exactly once per payment) → receipt (received / applied /
 *   excess held) → invoice status (allocation-derived) → audit (invoiceSettlements/{paymentRef}).
 *
 * SETTLEMENT TABLE (received = the verified amount; balance read INSIDE the allocation transaction):
 *   received = balance → allocate all  · wallet: received − fee
 *   received < balance → allocate all  · wallet: received − fee · invoice stays partially_paid
 *   received > balance → allocate balance · wallet: balance − fee · (received − balance) HELD + flagged, never credited
 *   unresolvable       → allocate none · wallet: nothing · the WHOLE amount HELD + flagged (invoicePaymentHolds/{ref})
 *
 * Authority: the verified webhook only. The callback body is a CLAIM; IntaSend's own server-to-server confirmation of
 * the same amount (injected `confirm`) is the evidence. A merchant reference / payment claim never reaches this file.
 * Never throws into the webhook: everything it cannot resolve is HELD and FLAGGED, never dropped and never credited.
 * Returns false when the payment is not an invoice payment (the webhook falls through).
 */
const HOLDS = 'invoicePaymentHolds';
const SETTLEMENTS = 'invoiceSettlements';
const ENTRY_PREFIX = 'invoice_';

/** The wallet-entry ref for one payment — ONE credit per verified payment, ever. */
const walletRefFor = (BW, apiRef) => BW.assertRef(ENTRY_PREFIX + String(apiRef).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120));

async function settleInvoicePayment(db, adminSdk, p) {
  const FV = adminSdk.firestore.FieldValue;
  const apiRef = String(p.apiRef || '');
  const intentId = String(p.intentRef || apiRef);
  let intent;
  try {
    const iSnap = await db.collection('paymentIntents').doc(intentId).get();
    intent = iSnap.exists ? (iSnap.data() || {}) : null;
  } catch (_) { return false; }
  if (!intent || intent.resourceType !== 'invoice') return false;

  const m = intent.metadata || {};
  const invoiceId = String(intent.resourceId || m.invoiceId || '');
  const receivedCents = Math.round(Number(p.grossAmount) * 100);
  const hold = async (reason, extra) => {
    const row = Object.assign({
      kind: 'invoice_payment', reason, status: 'held', flagged: true, paymentRef: apiRef, intentRef: intentId,
      invoiceId: invoiceId || null, receivedCents: Number.isInteger(receivedCents) && receivedCents > 0 ? receivedCents : null,
      sellerUid: m.sellerUid || null, providerRef: p.invoiceId ? String(p.invoiceId) : null, createdAt: FV.serverTimestamp(),
    }, extra || {});
    await db.collection(HOLDS).doc(apiRef).set(row, { merge: true });
    await db.collection('adminAlerts').doc('invoice_payment_held__' + apiRef).set({
      kind: 'invoice_payment_held', severity: 'high', reason, paymentRef: apiRef, invoiceId: invoiceId || null,
      message: 'A verified invoice payment could not be settled and is HELD for review (' + reason + '). Nothing was credited.',
      createdAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
    await db.collection('paymentIntents').doc(intentId).set({ status: 'held_review', paymentRef: apiRef, updatedAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
    return { outcome: 'held', reason };
  };

  /* ── 1 · every refusable check BEFORE any money moves ── */
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(invoiceId)) return hold('no_invoice_ref');
  if (!Number.isInteger(receivedCents) || receivedCents <= 0) return hold('amount_invalid');
  if (intent.currency && String(intent.currency).toUpperCase() !== 'KES') return hold('currency_mismatch');
  if (m.payeeWallet !== 'business' || !m.sellerUid) return hold('no_payee');
  const payer = intent.uid || intent.ownerUid || null;
  if (!payer) return hold('no_payer');
  if (String(payer) === String(m.sellerUid)) return hold('payer_is_merchant');   /* owner: anyone EXCEPT the issuing merchant */
  const SA = require('./shared/settlement-authority');
  const snap = m.commissionSnapshot;
  /* the rate CAPTURED AT PAYMENT START (2f) — immutable for this payment; never today's table */
  if (!SA.validSnapshot(snap) || snap.commissionBase !== 'invoice_balance') return hold('no_commission_snapshot');
  let pc;
  try { pc = await p.confirm(receivedCents); } catch (_) { pc = { ok: false, reason: 'provider_unreachable' }; }
  if (!pc || pc.ok !== true) return hold((pc && pc.reason) || 'provider_unconfirmed');
  const D = p.deps || {};
  const BW = D.BW || require('./business-wallet');
  const SD = D.SD || require('./settlement-destination');
  let dest;
  try { dest = await SD.resolveSettlementDestination(db, { sellerUid: m.sellerUid, paymentVerified: true }); } catch (_) { dest = { ok: false, reason: 'destination_unreadable' }; }
  if (!dest || dest.ok !== true || !dest.businessId) return hold('no_business_wallet', { destinationReason: (dest && dest.reason) || null });

  /* ── 2 · allocation (f3): ONE per payment; the balance is read inside its transaction ── */
  const IA = require('./invoice-allocation');
  let alloc;
  try {
    alloc = await IA.applyVerifiedPayment(db, { invoiceId, paymentId: apiRef, amountCents: receivedCents, currency: 'KES',
      provider: 'intasend', providerRef: p.invoiceId ? String(p.invoiceId) : null, FieldValue: FV });
  } catch (e) {
    if (e instanceof IA.AllocationError || (e && e.code && typeof e.code === 'string')) return hold('allocation_refused', { allocationCode: e.code || null });
    return hold('allocation_failed', { error: String(e && e.message || e).slice(0, 200) });
  }
  /* a replayed allocation carries no amounts — recover them from the allocation record so the credit and receipt
     below complete exactly once even when an earlier attempt stopped half-way */
  let appliedCents = alloc.appliedCents, excessHeldCents = alloc.excessHeldCents, rec = receivedCents;
  if (alloc.replay) {
    const a = (await db.collection('invoices').doc(invoiceId).collection('allocations').doc(apiRef).get()).data() || {};
    appliedCents = a.amountCents; excessHeldCents = a.excessHeldCents || 0; rec = a.receivedCents || receivedCents;
  }
  if (!Number.isInteger(appliedCents) || appliedCents < 0) return hold('allocation_unreadable');

  /* ── 3 · 15% on the APPLIED amount, from the captured snapshot ── */
  let commissionCents = 0, netCents = 0;
  if (appliedCents > 0) {
    const s = SA.settle({ heldAmountCents: appliedCents, passThroughCents: 0, commissionSnapshot: snap });
    if (!s || s.ok !== true || s.needsLegacy) return hold('settle_refused', { appliedCents, excessHeldCents });
    commissionCents = s.commissionCents; netCents = s.netCents;
  }

  /* ── 4 · the merchant BUSINESS wallet: exactly once per payment (entry create keyed on the payment ref) ── */
  const businessId = String(dest.businessId);
  const ref = walletRefFor(BW, apiRef);
  const bwRef = db.collection(BW.WALLETS).doc(businessId);
  const beRef = db.collection(BW.ENTRIES).doc(BW.entryDocId(businessId, ref));
  const setRef = db.collection(SETTLEMENTS).doc(apiRef);
  let credited;
  try {
    credited = await db.runTransaction(async (t) => {
      const [bw, be, st] = await Promise.all([t.get(bwRef), t.get(beRef), t.get(setRef)]);   /* reads first */
      if (be.exists || st.exists) return { replay: true };
      const w = bw.exists ? (bw.data() || {}) : {};
      const plan = netCents >= 1 ? BW.planMove(+1, { amountMinor: netCents, recovery: true,
        balanceBeforeMinor: Number(w.balanceMinor || 0), recoveryDebtBeforeMinor: Number(w.recoveryDebtMinor || 0) }) : null;
      if (plan) {
        if (!bw.exists) t.set(bwRef, { businessId, ownerId: dest.ownerUid || m.sellerUid, storeId: dest.storeId || null, currency: 'KES',
          balanceMinor: 0, recoveryDebtMinor: 0, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
        t.create(beRef, { ref, businessId, storeId: dest.storeId || null, direction: 'credit', amountMinor: plan.amountMinor,
          balanceBeforeMinor: plan.balanceBeforeMinor, balanceAfterMinor: plan.balanceAfterMinor, appliedToDebtMinor: plan.appliedToDebtMinor,
          shortfallMinor: plan.shortfallMinor, recoveryDebtBeforeMinor: plan.recoveryDebtBeforeMinor, recoveryDebtAfterMinor: plan.recoveryDebtAfterMinor,
          currency: 'KES', kind: 'invoice_settlement', sourceUid: intent.uid || null,
          source: { channel: 'ONLINE', businessId, method: p.providerMethod || null, grossMinor: appliedCents, commissionMinor: commissionCents, invoiceId },
          metadata: { invoiceId, intentRef: intentId, paymentRef: apiRef }, createdAt: FV.serverTimestamp() });
        t.set(bwRef, { balanceMinor: plan.balanceAfterMinor, recoveryDebtMinor: plan.recoveryDebtAfterMinor, updatedAt: FV.serverTimestamp() }, { merge: true });
      }
      /* the audit record of THIS settlement — create-once; carries the immutable snapshot it was priced with */
      t.create(setRef, { paymentRef: apiRef, intentRef: intentId, invoiceId, sellerUid: m.sellerUid, businessId, walletEntryRef: plan ? ref : null,
        receivedCents: rec, appliedCents, excessHeldCents, commissionCents, netCents, creditedMinor: plan ? plan.amountMinor : 0,
        commissionSnapshot: { commissionRate: Number(snap.commissionRate), commissionRuleId: String(snap.commissionRuleId), commissionBase: snap.commissionBase,
          category: snap.category || null, policyVersion: snap.policyVersion || null, capturedOnCents: snap.capturedOnCents == null ? null : snap.capturedOnCents },
        authority: 'intasend_webhook_verified', status: 'settled', createdAt: FV.serverTimestamp() });
      return { replay: false, creditedMinor: plan ? plan.amountMinor : 0 };
    });
  } catch (e) {
    /* allocation landed, the credit did not: money is HELD (never lost, never double-paid) and flagged for a person */
    return hold('settlement_failed', { appliedCents, excessHeldCents, commissionCents, netCents, businessId, error: String(e && e.message || e).slice(0, 200) });
  }
  if (excessHeldCents > 0) {
    await db.collection('adminAlerts').doc('invoice_overpaid__' + apiRef).set({ kind: 'invoice_overpaid', severity: 'high', paymentRef: apiRef, invoiceId,
      excessHeldCents, message: 'An invoice was overpaid; the excess is HELD (invoiceExcessHolds/' + apiRef + ') — refund or resolve it.', createdAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
  }
  await db.collection('paymentIntents').doc(intentId).set({ status: 'paid', paymentRef: apiRef, updatedAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});

  /* ── 5 · THE RECEIPT: received (paid), applied (released: fee + merchant net), excess (still held) ── */
  const TR = require('./transaction-receipts');
  const paidArgs = { kind: 'invoice', sourceId: apiRef.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120), clientUid: payer,
    counterpartyId: m.sellerUid, paymentRef: apiRef, providerRef: p.invoiceId ? String(p.invoiceId) : null, paidCents: rec,
    method: p.providerMethod || null, serviceLabel: 'Invoice ' + (m.invoiceNumber || invoiceId), links: { invoiceId } };
  const receipt = await TR.safely(db, 'invoice_paid_' + apiRef, () => TR.recordPaid(db, paidArgs, p.receiptDeps), { op: 'paid', args: paidArgs });
  let released = null;
  if (appliedCents > 0) {
    const receiptId = TR.receiptIdFor('invoice', paidArgs.sourceId);
    const evArgs = { type: 'released', amountCents: appliedCents, platformFeeCents: commissionCents, providerNetCents: netCents, opKey: apiRef };
    released = await TR.safely(db, 'invoice_released_' + apiRef, () => TR.recordEvent(db, receiptId, evArgs, p.receiptDeps), { op: 'event', receiptId, args: evArgs });
  }
  return { outcome: 'settled', invoiceId, receivedCents: rec, appliedCents, excessHeldCents, commissionCents, netCents,
    creditReplay: credited.replay === true, allocationReplay: alloc.replay === true, receipt, released };
}

module.exports = { settleInvoicePayment, walletRefFor, HOLDS, SETTLEMENTS };
