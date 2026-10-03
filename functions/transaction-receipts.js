/* ============================================================================
   TRANSACTION RECEIPTS — one platform-wide payment receipt per paid transaction (owner 2026-10-03, via sokoni-b2)
   ----------------------------------------------------------------------------
   Owner: "Every paid booking / accepted quote gets an invoice/receipt through the shared billing system" — platform-wide,
   not Legal-specific — with: invoice ID, booking/quote ID, client, provider/firm, service, quoted amount, VAT/tax treatment
   where applicable, SOKONI fee/commission, amount held, amount released, payment reference, payment method, status,
   payment confirmation, timestamps, refund/adjustment history. Milestones are NOT in this release, but the model must
   take them later without rewriting booking or ledger.

   WHAT THIS IS — AND IS NOT
   • A PAYMENT RECEIPT issued by SOKONI as the collecting platform: proof that the buyer paid and of where the money is
     (held → released / refunded). It is NOT a tax invoice for the provider's service — that is the provider's own
     fiscal document (etims.generateForOrder via their eTIMS profile). SOKONI's fee to the provider is SOKONI's own
     supply, invoiced through the ONE platform engine (etims._issuePlatformInvoice). So no VAT is computed here:
     taxTreatment is RECORDED, never inferred ('provider_fiscal_invoice' | 'not_vat_registered' | 'unknown').
   • Not a second engine: numbering reuses financial-engine._nextNumber ('RCT' series, SKN-RCT-YYYY-NNNNNN).
     financial-engine.recordConfirmedPayment itself is NOT used for marketplace money: it applies a default 16 %
     VAT-inclusive split to the whole gross and journals it all as SOKONI REVENUE — wrong for a provider's service.
     Its only caller was the deleted Daraja callback; it stays unwired pending its own VAT decision.

   DATA
     transactionReceipts/{receiptId}   receiptId = kind + '_' + sourceId  (one per booking / quote / order)
        IMMUTABLE HEADER (set once at the verified payment):
          receiptNo, kind ('service_booking' | 'quote' | 'order'), sourceId, clientUid, counterpartyId, counterpartyName,
          serviceLabel, quotedCents, currency, paymentRef, providerRef, method (as reported by the provider; null = unknown),
          taxTreatment, issuedAt, confirmation { source:'intasend_webhook', verifiedAt }
        RUNNING POSITION (changed ONLY together with an event, in the same transaction):
          paidCents, heldCents, releasedCents, refundedCents, platformFeeCents, providerNetCents, status, updatedAt
     transactionReceipts/{receiptId}/events/{eventId}   IMMUTABLE, create() — the refund/adjustment history
          type 'paid' | 'released' | 'refunded' | 'adjusted', amountCents, platformFeeCents?, providerNetCents?,
          reason?, milestoneId? (reserved: a milestone release is just another 'released' event with its id), opKey, at
   Idempotency: the receipt by create(); every event id is deterministic (type + '_' + opKey) and created in the same
   transaction as the position change, so a replayed webhook / retried release / repeated refund changes nothing.
   Never throws into a money path: failures go to transactionReceiptFailures for the sweep.
   ============================================================================ */
'use strict';

const RECEIPTS = 'transactionReceipts';
const FAILURES = 'transactionReceiptFailures';
const KINDS = Object.freeze(['service_booking', 'quote', 'order']);
const TAX = Object.freeze(['provider_fiscal_invoice', 'not_vat_registered', 'unknown']);
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const _int = (n) => (Number.isInteger(n) && n >= 0 ? n : null);

function receiptIdFor(kind, sourceId) { return String(kind) + '_' + String(sourceId); }

function _statusOf(p) {
  if (p.refundedCents > 0 && p.refundedCents >= p.paidCents) return 'refunded';
  if (p.refundedCents > 0) return 'partially_refunded';
  if (p.heldCents > 0 && p.releasedCents > 0) return 'partially_released';
  if (p.heldCents > 0) return 'paid_held';
  if (p.releasedCents > 0) return 'released';
  return 'paid';
}

/**
 * The verified payment. Call from the webhook path AFTER the payment is verified (never from a browser).
 * @returns {Promise<{ok, receiptId, receiptNo?, replay?}>}
 */
async function recordPaid(db, p, deps) {
  const d = deps || {};
  const ts = d.serverTs || (() => new Date());
  const kind = String(p.kind || '');
  const sourceId = String(p.sourceId || '');
  const paidCents = _int(p.paidCents);
  if (!KINDS.includes(kind) || !ID_RE.test(sourceId) || !p.clientUid || !p.paymentRef || !paidCents) return { ok: false, reason: 'bad_receipt' };
  const taxTreatment = TAX.includes(p.taxTreatment) ? p.taxTreatment : 'unknown';
  const receiptId = receiptIdFor(kind, sourceId);
  const ref = db.collection(RECEIPTS).doc(receiptId);
  const evRef = ref.collection('events').doc('paid_' + String(p.paymentRef).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120));
  const nextNumber = d.nextNumber || ((k) => require('./financial-engine')._nextNumber(k));
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (s.exists) return { ok: true, receiptId, receiptNo: (s.data() || {}).receiptNo || null, replay: true };
    const receiptNo = await nextNumber('RCT');
    const held = p.held === false ? 0 : paidCents;
    const pos = { paidCents, heldCents: held, releasedCents: p.held === false ? paidCents : 0, refundedCents: 0,
      platformFeeCents: 0, providerNetCents: 0 };
    t.create(ref, Object.assign({
      receiptNo, kind, sourceId, clientUid: String(p.clientUid), counterpartyId: p.counterpartyId ? String(p.counterpartyId) : null,
      counterpartyName: p.counterpartyName ? String(p.counterpartyName).slice(0, 160) : null,
      serviceLabel: p.serviceLabel ? String(p.serviceLabel).slice(0, 200) : null,
      quotedCents: _int(p.quotedCents) != null ? p.quotedCents : paidCents, currency: 'KES',
      paymentRef: String(p.paymentRef), providerRef: p.providerRef ? String(p.providerRef) : null,
      method: p.method ? String(p.method).slice(0, 40) : null,          /* as reported by IntaSend; null = not reported */
      taxTreatment, confirmation: { source: 'intasend_webhook', verifiedAt: ts() },
      issuedAt: ts(), updatedAt: ts(),
    }, pos, { status: _statusOf(pos) }));
    t.create(evRef, { type: 'paid', amountCents: paidCents, opKey: String(p.paymentRef), at: ts() });
    return { ok: true, receiptId, receiptNo, replay: false };
  });
}

/**
 * A later money event on an existing receipt: release (PIN / show-up / milestone), refund, or adjustment.
 * opKey makes it exactly-once (e.g. the bookingId for a full release, refund id for a refund, milestone id later).
 */
async function recordEvent(db, receiptId, e, deps) {
  const d = deps || {};
  const ts = d.serverTs || (() => new Date());
  const type = String(e.type || '');
  const amount = _int(e.amountCents);
  if (!['released', 'refunded', 'adjusted'].includes(type) || amount == null || !e.opKey) return { ok: false, reason: 'bad_event' };
  const ref = db.collection(RECEIPTS).doc(String(receiptId));
  const evRef = ref.collection('events').doc(type + '_' + String(e.opKey).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120));
  return db.runTransaction(async (t) => {
    const [s, ev] = await Promise.all([t.get(ref), t.get(evRef)]);
    if (!s.exists) return { ok: false, reason: 'no_receipt' };
    if (ev.exists) return { ok: true, replay: true };
    const cur = s.data() || {};
    const pos = { paidCents: cur.paidCents || 0, heldCents: cur.heldCents || 0, releasedCents: cur.releasedCents || 0,
      refundedCents: cur.refundedCents || 0, platformFeeCents: cur.platformFeeCents || 0, providerNetCents: cur.providerNetCents || 0 };
    if (type === 'released') {
      if (amount > pos.heldCents) return { ok: false, reason: 'release_exceeds_held' };
      pos.heldCents -= amount; pos.releasedCents += amount;
      pos.platformFeeCents += _int(e.platformFeeCents) || 0;
      pos.providerNetCents += _int(e.providerNetCents) || 0;
    } else if (type === 'refunded') {
      if (pos.refundedCents + amount > pos.paidCents) return { ok: false, reason: 'refund_exceeds_paid' };
      const fromHeld = Math.min(amount, pos.heldCents);
      pos.heldCents -= fromHeld; pos.refundedCents += amount;
    }
    t.create(evRef, Object.assign({ type, amountCents: amount, opKey: String(e.opKey), at: ts() },
      e.platformFeeCents != null ? { platformFeeCents: _int(e.platformFeeCents) || 0 } : {},
      e.providerNetCents != null ? { providerNetCents: _int(e.providerNetCents) || 0 } : {},
      e.reason ? { reason: String(e.reason).slice(0, 300) } : {},
      e.milestoneId ? { milestoneId: String(e.milestoneId).slice(0, 120) } : {}));
    t.update(ref, Object.assign({}, pos, { status: _statusOf(pos), updatedAt: ts() }));
    return { ok: true, replay: false, status: _statusOf(pos) };
  });
}

/** Never-throwing wrapper for money paths: a failure is queued for the sweep, the payment is unaffected. */
async function safely(db, label, fn) {
  try { return await fn(); } catch (err) {
    try {
      await db.collection(FAILURES).add({ label: String(label).slice(0, 200), error: String(err && err.message || err).slice(0, 300), at: new Date() });
    } catch (_) { /* nothing further */ }
    return { ok: false, reason: 'queued_for_retry' };
  }
}

/** The caller's own receipts (client or counterparty). Server-scoped read; header + position + events. */
async function receiptsFor(db, uid, opts) {
  const lim = Math.min(Math.max(Number(opts && opts.limit) || 20, 1), 50);
  const [asClient, asCounterparty] = await Promise.all([
    db.collection(RECEIPTS).where('clientUid', '==', String(uid)).limit(lim).get(),
    db.collection(RECEIPTS).where('counterpartyId', '==', String(uid)).limit(lim).get(),
  ]);
  const seen = new Set(); const out = [];
  for (const doc of asClient.docs.concat(asCounterparty.docs)) {
    if (seen.has(doc.id)) continue; seen.add(doc.id);
    out.push(Object.assign({ receiptId: doc.id, role: (doc.data() || {}).clientUid === String(uid) ? 'client' : 'provider' }, doc.data()));
  }
  return out;
}

/* ── deployable: the caller's receipts ── */
let myTransactionReceipts;
{
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  myTransactionReceipts = onCall({ region: 'us-central1', maxInstances: 20 }, async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in to see your receipts.');
    try {
      const rows = await receiptsFor(require('firebase-admin').firestore(), req.auth.uid, req.data || {});
      return { ok: true, receipts: rows.map((r) => Object.assign({}, r, {
        issuedAt: r.issuedAt && r.issuedAt.toMillis ? r.issuedAt.toMillis() : r.issuedAt || null,
        updatedAt: r.updatedAt && r.updatedAt.toMillis ? r.updatedAt.toMillis() : r.updatedAt || null,
        confirmation: r.confirmation ? { source: r.confirmation.source } : null })) };
    } catch (e) {
      throw new HttpsError('unavailable', 'Your receipts could not be loaded. Try again shortly.');
    }
  });
}

module.exports = { RECEIPTS, FAILURES, KINDS, TAX, receiptIdFor, recordPaid, recordEvent, safely, receiptsFor, myTransactionReceipts, _statusOf };
