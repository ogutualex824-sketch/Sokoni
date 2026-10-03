'use strict';
/**
 * Provider money view — ONE read-only projection of canonical records for the merchant-v2 provider screens
 * (Payments / Earnings / Pending / Available / Commission / Refunds / Adjustments / Settlements / Payout history).
 * Requested by sokoni-b2 for the Marketing release gates (owner 2026-10-03). It writes NOTHING and computes no money:
 *
 *   available   ← wallets/{uid}.balance (whole shillings — the withdrawable field every payout path uses)
 *   pending     ← providerBookings this provider is paid on but not yet released (paymentStatus 'paid_held')
 *   totals      ← transactionReceipts where counterpartyId == caller (the platform receipt — gross, platform fee,
 *                 provider net, refunded, deductions, released), over a BOUNDED window that is reported as such
 *   entries     ← walletTransactions where uid == caller, newest first, each with its booking/order/payment links
 *   payouts     ← payoutRequests where sellerUid == caller (history; the request path itself is wallet.requestSellerPayout)
 *
 * Unknown is never 0: a source that cannot be read returns null + a reason, so the UI renders "—" (UI Data Integrity).
 * wallet.js is frozen — this module only reads the same collections; it never replaces or wraps the payout writer.
 */
const WINDOW = 200;      /* receipts / bookings scanned for totals — reported in the response, never hidden */
const ENTRY_LIMIT = 100;

const _ms = (v) => (v && v.toMillis ? v.toMillis() : (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : (Date.parse(v || '') || null))));
const _int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

async function _safe(label, fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, reason: label + '_unreadable' }; }
}

async function ledgerFor(db, uid) {
  const [wallet, held, receipts, entries, payouts] = await Promise.all([
    _safe('wallet', async () => { const s = await db.collection('wallets').doc(String(uid)).get(); return s.exists ? s.data() : null; }),
    /* equality-only (providerId + paymentStatus): served by single-field index merge, no composite needed */
    _safe('bookings', async () => (await db.collection('providerBookings').where('providerId', '==', String(uid)).where('paymentStatus', '==', 'paid_held').limit(WINDOW).get()).docs),
    _safe('receipts', async () => (await db.collection('transactionReceipts').where('counterpartyId', '==', String(uid)).limit(WINDOW).get()).docs),
    _safe('entries', async () => {
      /* newest first via (uid, createdAt desc); if that index is not built yet, fall back to an unordered slice (sorted below) */
      try { return (await db.collection('walletTransactions').where('uid', '==', String(uid)).orderBy('createdAt', 'desc').limit(ENTRY_LIMIT).get()).docs; }
      catch (e) { if (!/index|FAILED_PRECONDITION/i.test(String((e && e.code) || '') + ' ' + String((e && e.message) || ''))) throw e;
        return (await db.collection('walletTransactions').where('uid', '==', String(uid)).limit(ENTRY_LIMIT * 3).get()).docs; }
    }),
    _safe('payouts', async () => (await db.collection('payoutRequests').where('sellerUid', '==', String(uid)).limit(50).get()).docs),
  ]);

  const out = { ok: true, uid: String(uid), currency: 'KES', reasons: [] };
  const miss = (r) => { if (!r.ok) out.reasons.push(r.reason); return !r.ok; };

  /* available: a missing wallet doc is a real, known 0 (no earnings credited yet); an unreadable one is unknown */
  out.availableKES = miss(wallet) ? null : (wallet.value ? Math.max(0, _int(wallet.value.balance)) : 0);

  if (miss(held)) out.pending = null;
  else {
    const rows = held.value.map((d) => ({ id: d.id, b: d.data() || {} })).filter(({ b }) => b.paymentStatus === 'paid_held');
    out.pending = { count: rows.length, amountCents: rows.reduce((t, { b }) => t + (_int(b.heldAmount) || (_int(b.price) + _int(b.fee))), 0),
      bookings: rows.slice(0, 50).map(({ id, b }) => ({ bookingId: id, kind: b.kind || 'service_booking', service: b.service || null,
        amountCents: _int(b.heldAmount) || (_int(b.price) + _int(b.fee)), status: b.status || null, workProjectId: b.workProjectId || null, milestoneId: b.milestoneId || null })),
      window: { scanned: held.value.length, truncated: held.value.length >= WINDOW } };
  }

  if (miss(receipts)) out.totals = null;
  else {
    const t = { grossCents: 0, platformFeeCents: 0, providerNetCents: 0, refundedCents: 0, deductionsCents: 0, releasedCents: 0, heldCents: 0 };
    for (const d of receipts.value) {
      const r = d.data() || {};
      t.grossCents += _int(r.paidCents); t.platformFeeCents += _int(r.platformFeeCents); t.providerNetCents += _int(r.providerNetCents);
      t.refundedCents += _int(r.refundedCents); t.deductionsCents += _int(r.deductionsCents); t.releasedCents += _int(r.releasedCents); t.heldCents += _int(r.heldCents);
    }
    out.totals = Object.assign(t, { source: 'transactionReceipts', window: { scanned: receipts.value.length, truncated: receipts.value.length >= WINDOW } });
  }

  if (miss(entries)) out.entries = null;
  else {
    out.entries = entries.value.map((d) => ({ id: d.id, x: d.data() || {} })).sort((a, b) => (_ms(b.x.createdAt) || 0) - (_ms(a.x.createdAt) || 0))
      .slice(0, ENTRY_LIMIT).map(({ id, x }) => ({ id, type: x.type || null, amountKES: _int(x.amount), status: x.status || null,
        description: x.description ? String(x.description).slice(0, 200) : null, bookingId: x.bookingId || null, orderId: x.orderId || null,
        paymentRef: x.paymentRef || null, trigger: x.trigger || null, createdAt: _ms(x.createdAt) }));
  }

  if (miss(payouts)) out.payouts = null;
  else {
    out.payouts = payouts.value.map((d) => ({ id: d.id, p: d.data() || {} })).sort((a, b) => (_ms(b.p.createdAt) || 0) - (_ms(a.p.createdAt) || 0))
      .map(({ id, p }) => ({ id, amountKES: _int(p.amount), status: p.status || null, method: p.method || null,
        reference: p.reference || p.payoutRef || null, createdAt: _ms(p.createdAt), paidAt: _ms(p.paidAt) }));
  }

  /* Eligibility is STATED by the server; the request itself stays wallet.requestSellerPayout (frozen; owner-gated). */
  out.payoutEligibility = out.availableKES === null ? null
    : { minimumKES: 100, availableKES: out.availableKES, eligible: out.availableKES >= 100, requestPath: 'requestSellerPayout' };
  return out;
}

let providerLedger;
{
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  providerLedger = onCall({ region: 'us-central1', maxInstances: 20, enforceAppCheck: true }, async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in to see your earnings.');
    try { return await ledgerFor(require('firebase-admin').firestore(), req.auth.uid); }
    catch (e) { throw new HttpsError('unavailable', 'Your earnings could not be loaded. Try again shortly.'); }
  });
}

module.exports = { ledgerFor, providerLedger, WINDOW, ENTRY_LIMIT };
