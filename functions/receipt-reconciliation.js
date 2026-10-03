/* ============================================================================
   RECEIPT RECONCILIATION — payment ↔ receipt ↔ settlement consistency (owner 2026-10-03)
   ----------------------------------------------------------------------------
   Finds disagreements and records them as EXCEPTIONS. It never corrects anything: a mismatch is an investigation,
   not a write. A receipt never decides who owns money — the payment / webhook and the ledger do.

   Checks (service bookings first — the flow whose hooks land first; other kinds join as their hooks land):
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
      const r = await db.collection(RECEIPTS).doc('service_booking_' + b.id).get();
      if (!r.exists) { flag('missing_receipt', b.id, 'receipt', null); continue; }
      const rc = r.data() || {};
      const held = Number(bk.heldAmount);
      if (Number.isFinite(held) && held > 0 && rc.paidCents !== held) flag('paid_mismatch', b.id, held, rc.paidCents);
      if (st === 'settled') {
        if (!(rc.releasedCents > 0)) flag('release_missing', b.id, 'released > 0', rc.releasedCents || 0);
        const po = await db.collection('providerPayouts').doc(b.id).get();
        const sc = po.exists ? Number((po.data() || {}).settlementCents) : NaN;
        if (Number.isFinite(sc) && rc.providerNetCents !== sc) flag('provider_share_mismatch', b.id, sc, rc.providerNetCents);
      }
      const rf = Number(bk.refundedCents) || 0;
      if ((rc.refundedCents || 0) !== rf) flag('refund_mismatch', b.id, rf, rc.refundedCents || 0);
    }
  }
  /* From the receipts side: a receipt must point at a real booking. */
  const rs = await db.collection(RECEIPTS).where('kind', '==', 'service_booking').limit(lim).get();
  for (const r of rs.docs) {
    const id = (r.data() || {}).sourceId;
    const b = await db.collection('providerBookings').doc(String(id)).get();
    if (!b.exists) flag('orphan_receipt', id, 'booking', null);
  }

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
