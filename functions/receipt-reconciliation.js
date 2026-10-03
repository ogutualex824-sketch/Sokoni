/* ============================================================================
   RECEIPT RECONCILIATION — payment ↔ receipt ↔ settlement consistency (owner 2026-10-03)
   ----------------------------------------------------------------------------
   Finds disagreements and records them as EXCEPTIONS. It never corrects anything: a mismatch is an investigation,
   not a write. A receipt never decides who owns money — the payment / webhook and the ledger do.

   Checks (service bookings first — the flow whose hooks land first; other kinds join as their hooks land). Added 2026-10-03:
     receipt_without_payment · invalid_history · history_total_mismatch · release_without_hold · duplicate_payment_ref ·
     hold_without_payment · wallet_mismatch · quote_link_mismatch · duplicate_receipt (quote-originated bookings are
     receipted under the QUOTE: kind quote, links.bookingId).
     missing_receipt        a paid booking (paid_held / settled / refunded*) has no receipt
     orphan_receipt         a receipt whose booking does not exist
     paid_mismatch          receipt.paidCents ≠ booking.heldAmount (the verified amount)
     release_missing        booking settled, receipt shows nothing released
     provider_share_mismatch receipt.providerNetCents ≠ providerPayouts/{id}.settlementCents
     refund_mismatch        receipt.refundedCents ≠ booking.refundedCents
   Exceptions: receiptReconciliationExceptions/{check}_{sourceId} — set(merge) so a recurring mismatch stays ONE open
   exception with firstSeenAt / lastSeenAt; status 'resolved' is set by a human in AdminOS, never by this job.
   ============================================================================ */
'use strict';

const EXC = 'receiptReconciliationExceptions';
const PAID_STATES = ['paid_held', 'settled', 'refunded', 'refunded_after_settlement'];
const RECEIPTS = 'transactionReceipts';

async function reconcileServiceBookings(db, opts) {
  const lim = Math.min(Number(opts && opts.limit) || 300, 1000);
  const now = (opts && opts.now) ? opts.now() : new Date();
  const found = [];
  const flag = (check, sourceId, expected, actual) => found.push({ check, sourceId: String(sourceId), expected, actual });

  /* From the bookings side. */
  for (const st of PAID_STATES) {
    const snap = await db.collection('providerBookings').where('paymentStatus', '==', st).limit(lim).get();
    for (const b of snap.docs) {
      const bk = b.data() || {};
      /* hold_without_payment: a booking marked paid/held must cite a CONFIRMED payment. */
      if (bk.paymentRef) {
        const [pay, intent] = await Promise.all([
          db.collection('payments').doc(String(bk.paymentRef)).get(),
          db.collection('paymentIntents').doc(String(bk.paymentRef)).get(),
        ]);
        const confirmed = (pay.exists && String((pay.data() || {}).status || '').toUpperCase() === 'COMPLETE') || (intent.exists && (intent.data() || {}).status === 'paid');
        if (!confirmed) flag('hold_without_payment', b.id, 'confirmed payment ' + bk.paymentRef, null);
      } else {
        flag('hold_without_payment', b.id, 'a paymentRef', null);
      }
      /* The receipt is the booking's own — OR, for a booking that came from an accepted Legal/Tech quote, the QUOTE's
         receipt (kind 'quote', links.bookingId == this booking). */
      let r = await db.collection(RECEIPTS).doc('service_booking_' + b.id).get();
      if (!r.exists) {
        const qs = await db.collection(RECEIPTS).where('links.bookingId', '==', b.id).limit(2).get();
        if (qs.docs.length > 1) flag('duplicate_receipt', b.id, 1, qs.docs.map((d) => d.id));
        r = qs.docs[0] || r;
      }
      if (!r.exists) { flag('missing_receipt', b.id, 'receipt', null); continue; }
      const rc = r.data() || {};
      /* quote_link_mismatch: a quote receipt must name THIS booking's buyer and provider. */
      if (rc.kind === 'quote' && ((bk.customerUid && rc.clientUid !== bk.customerUid) || (bk.providerId && rc.counterpartyId !== bk.providerId))) {
        flag('quote_link_mismatch', b.id, { clientUid: bk.customerUid || null, providerId: bk.providerId || null }, { clientUid: rc.clientUid, counterpartyId: rc.counterpartyId });
      }
      const held = Number(bk.heldAmount);
      if (Number.isFinite(held) && held > 0 && rc.paidCents !== held) flag('paid_mismatch', b.id, held, rc.paidCents);
      if (st === 'settled') {
        if (!(rc.releasedCents > 0)) flag('release_missing', b.id, 'released > 0', rc.releasedCents || 0);
        const po = await db.collection('providerPayouts').doc(b.id).get();
        const sc = po.exists ? Number((po.data() || {}).settlementCents) : NaN;
        if (Number.isFinite(sc) && rc.providerNetCents !== sc) flag('provider_share_mismatch', b.id, sc, rc.providerNetCents);
        /* wallet_mismatch: a payout that says it credited a wallet must point at a wallet transaction that exists. */
        const pd = po.exists ? (po.data() || {}) : {};
        if (pd.walletCredited === true) {
          const wt = pd.walletTxnId ? await db.collection('walletTransactions').doc(String(pd.walletTxnId)).get() : { exists: false };
          if (!wt.exists) flag('wallet_mismatch', b.id, 'walletTransactions/' + (pd.walletTxnId || '?'), null);
        }
      }
      const rf = Number(bk.refundedCents) || 0;
      if ((rc.refundedCents || 0) !== rf) flag('refund_mismatch', b.id, rf, rc.refundedCents || 0);
    }
  }
  /* From the receipts side: a receipt must point at a real booking. */
  const rs = await db.collection(RECEIPTS).where('kind', '==', 'service_booking').limit(lim).get();
  const byRef = new Map();
  for (const r of rs.docs) {
    const rc = r.data() || {};
    const id = rc.sourceId;
    const b = await db.collection('providerBookings').doc(String(id)).get();
    if (!b.exists) flag('orphan_receipt', id, 'booking', null);
    /* receipt_without_payment: the payment it cites must be a CONFIRMED payment (payments/{ref} COMPLETE or the intent paid). */
    if (rc.paymentRef) {
      const [pay, intent] = await Promise.all([
        db.collection('payments').doc(String(rc.paymentRef)).get(),
        db.collection('paymentIntents').doc(String(rc.paymentRef)).get(),
      ]);
      const ok = (pay.exists && String((pay.data() || {}).status || '').toUpperCase() === 'COMPLETE') || (intent.exists && (intent.data() || {}).status === 'paid');
      if (!ok) flag('receipt_without_payment', id, 'confirmed payment ' + rc.paymentRef, null);
      byRef.set(rc.paymentRef, (byRef.get(rc.paymentRef) || []).concat([id]));
    }
    /* invalid_history: the position must be possible — nothing released or refunded beyond what was paid, held never negative,
       and the stored totals must equal the sum of the immutable events. */
    const p = { paid: rc.paidCents || 0, held: rc.heldCents || 0, rel: rc.releasedCents || 0, ref: rc.refundedCents || 0 };
    if (p.held < 0 || p.rel > p.paid || p.ref > p.paid || p.held > p.paid) flag('invalid_history', id, 'held/released/refunded within paid', p);
    const ev = await db.collection(RECEIPTS).doc(r.id).collection('events').limit(200).get();
    const sum = { paid: 0, rel: 0, ref: 0 };
    for (const e of ev.docs) { const x = e.data() || {}; if (x.type === 'paid') sum.paid += x.amountCents || 0; else if (x.type === 'released') sum.rel += x.amountCents || 0; else if (x.type === 'refunded') sum.ref += x.amountCents || 0; }
    if (sum.paid !== p.paid || sum.rel !== p.rel || sum.ref !== p.ref) flag('history_total_mismatch', id, sum, { paid: p.paid, rel: p.rel, ref: p.ref });
    if (p.rel > 0 && sum.paid === 0) flag('release_without_hold', id, 'a paid/held event before release', null);
  }
  /* duplicate_payment_ref: one confirmed payment can back only ONE receipt. */
  for (const [ref, ids] of byRef) if (ids.length > 1) flag('duplicate_payment_ref', ref, 1, ids);

  for (const f of found) {
    const ref = db.collection(EXC).doc(f.check + '_' + f.sourceId);
    const prev = await ref.get();
    /* firstSeenAt is written once; a human-resolved exception that recurs is re-opened (it is a new disagreement). */
    await ref.set(Object.assign({
      check: f.check, kind: 'service_booking', sourceId: f.sourceId, expected: f.expected, actual: f.actual,
      status: 'open', lastSeenAt: now,
    }, prev.exists ? {} : { firstSeenAt: now }), { merge: true });
  }
  return { checked: true, exceptions: found.length, byCheck: found.reduce((m, f) => (m[f.check] = (m[f.check] || 0) + 1, m), {}) };
}

let receiptReconciliationDaily;
{
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  receiptReconciliationDaily = onSchedule({ schedule: '30 4 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1', memory: '512MiB', timeoutSeconds: 540 }, async () => {
    const out = await reconcileServiceBookings(require('firebase-admin').firestore());
    require('firebase-functions/logger').info('[receipts] reconciliation', out);
  });
}

module.exports = { EXC, PAID_STATES, reconcileServiceBookings, receiptReconciliationDaily };
