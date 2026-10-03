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
/* b2b_order: a buyer-paid wholesale order (0% commission; the supplier's lead-fee recovery is a DEDUCTION, never commission).
   enrolment: reserved for paid Education — NOT connected while paid enrolment stays shut (owner E1 rule). */
const KINDS = Object.freeze(['service_booking', 'quote', 'order', 'b2b_order', 'enrolment']);
/* Release deductions that are NOT SOKONI commission — shown separately on the receipt. */
const DEDUCTION_KINDS = Object.freeze(['lead_fee_recovery']);
const TAX = Object.freeze(['provider_fiscal_invoice', 'not_vat_registered', 'unknown']);
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const _int = (n) => (Number.isInteger(n) && n >= 0 ? n : null);

function _links(l) {
  const out = {};
  for (const k of ['quoteId', 'bookingId', 'orderId', 'purchaseOrderId', 'settlementId']) {
    if (l && l[k] != null && ID_RE.test(String(l[k]))) out[k] = String(l[k]);
  }
  return out;
}

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
      platformFeeCents: 0, providerNetCents: 0, deductionsCents: 0 };
    t.create(ref, Object.assign({
      receiptNo, kind, sourceId, clientUid: String(p.clientUid), counterpartyId: p.counterpartyId ? String(p.counterpartyId) : null,
      counterpartyName: p.counterpartyName ? String(p.counterpartyName).slice(0, 160) : null,
      serviceLabel: p.serviceLabel ? String(p.serviceLabel).slice(0, 200) : null,
      quotedCents: _int(p.quotedCents) != null ? p.quotedCents : paidCents, currency: 'KES',
      paymentRef: String(p.paymentRef), providerRef: p.providerRef ? String(p.providerRef) : null,
      method: p.method ? String(p.method).slice(0, 40) : null,          /* as reported by IntaSend; null = not reported */
      taxTreatment, confirmation: { source: 'intasend_webhook', verifiedAt: ts() },
      /* Cross-references (Legal: the accepted quote AND the booking it became; B2B: the purchase order). */
      links: _links(p.links),
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
  const fee = _int(e.platformFeeCents) || 0, net = _int(e.providerNetCents) || 0;
  const deductions = Array.isArray(e.deductions) ? e.deductions : [];
  for (const dd of deductions) {
    if (!DEDUCTION_KINDS.includes(dd && dd.kind) || _int(dd.amountCents) == null) return { ok: false, reason: 'bad_deduction' };
  }
  const dedTotal = deductions.reduce((t, dd) => t + dd.amountCents, 0);
  const ref = db.collection(RECEIPTS).doc(String(receiptId));
  const evRef = ref.collection('events').doc(type + '_' + String(e.opKey).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120));
  return db.runTransaction(async (t) => {
    const [s, ev] = await Promise.all([t.get(ref), t.get(evRef)]);
    if (!s.exists) return { ok: false, reason: 'no_receipt' };
    if (ev.exists) return { ok: true, replay: true };
    const cur = s.data() || {};
    const pos = { paidCents: cur.paidCents || 0, heldCents: cur.heldCents || 0, releasedCents: cur.releasedCents || 0,
      refundedCents: cur.refundedCents || 0, platformFeeCents: cur.platformFeeCents || 0, providerNetCents: cur.providerNetCents || 0,
      deductionsCents: cur.deductionsCents || 0 };
    if (type === 'released') {
      if (amount > pos.heldCents) return { ok: false, reason: 'release_exceeds_held' };
      /* A release must BALANCE: SOKONI fee + provider share + non-commission deductions = the amount released. */
      if (fee + net + dedTotal !== amount) return { ok: false, reason: 'unbalanced_release', detail: { amount, fee, net, deductions: dedTotal } };
      pos.heldCents -= amount; pos.releasedCents += amount;
      pos.platformFeeCents += fee;
      pos.providerNetCents += net;
      pos.deductionsCents += dedTotal;
    } else if (type === 'refunded') {
      if (pos.refundedCents + amount > pos.paidCents) return { ok: false, reason: 'refund_exceeds_paid' };
      const fromHeld = Math.min(amount, pos.heldCents);
      pos.heldCents -= fromHeld; pos.refundedCents += amount;
    }
    t.create(evRef, Object.assign({ type, amountCents: amount, opKey: String(e.opKey), at: ts() },
      e.platformFeeCents != null ? { platformFeeCents: _int(e.platformFeeCents) || 0 } : {},
      e.providerNetCents != null ? { providerNetCents: _int(e.providerNetCents) || 0 } : {},
      e.reason ? { reason: String(e.reason).slice(0, 300) } : {},
      e.milestoneId ? { milestoneId: String(e.milestoneId).slice(0, 120) } : {},
      deductions.length ? { deductions: deductions.map((dd) => ({ kind: dd.kind, amountCents: dd.amountCents, ref: dd.ref ? String(dd.ref).slice(0, 160) : null })) } : {}));
    t.update(ref, Object.assign({}, pos, { status: _statusOf(pos), updatedAt: ts() }));
    return { ok: true, replay: false, status: _statusOf(pos) };
  });
}

/** Never-throwing wrapper for money paths: a failure is queued (with a replayable payload) and the payment is unaffected.
    replay = { op: 'paid', args } | { op: 'event', receiptId, args } — retried by retryFailures; the receipt / event ids
    are deterministic, so a retry can only ever produce ONE receipt / ONE event. */
async function safely(db, label, fn, replay) {
  try { return await fn(); } catch (err) {
    try {
      await db.collection(FAILURES).add({ label: String(label).slice(0, 200), error: String(err && err.message || err).slice(0, 300),
        replay: replay ? JSON.parse(JSON.stringify(replay)) : null, status: 'open', attempts: 1, at: new Date() });
    } catch (_) { /* nothing further */ }
    return { ok: false, reason: 'queued_for_retry' };
  }
}

/** Retry queued failures. Each replays the SAME call; the deterministic ids make a duplicate impossible. */
async function retryFailures(db, deps, limit) {
  const snap = await db.collection(FAILURES).where('status', '==', 'open').limit(Math.min(Number(limit) || 50, 200)).get();
  const out = { scanned: snap.docs.length, resolved: 0, stillFailing: 0, notReplayable: 0 };
  for (const doc of snap.docs) {
    const f = doc.data() || {};
    const rp = f.replay;
    if (!rp || (rp.op !== 'paid' && rp.op !== 'event')) { out.notReplayable++; continue; }
    let r;
    try { r = rp.op === 'paid' ? await recordPaid(db, rp.args || {}, deps) : await recordEvent(db, rp.receiptId, rp.args || {}, deps); }
    catch (e) { r = { ok: false, reason: String(e && e.message || e).slice(0, 200) }; }
    if (r && r.ok) { await db.collection(FAILURES).doc(doc.id).set({ status: 'resolved', resolvedAt: new Date(), result: r.replay ? 'already_present' : 'written' }, { merge: true }); out.resolved++; }
    else { await db.collection(FAILURES).doc(doc.id).set({ attempts: (Number(f.attempts) || 1) + 1, lastError: (r && r.reason) || 'unknown', lastAttemptAt: new Date() }, { merge: true }); out.stillFailing++; }
  }
  return out;
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
  /* HISTORY (owner field list): each receipt's own immutable events, scoped exactly like the header — only receipts the
     caller is party to reach this point. Capped at 50 per receipt, oldest first; a projection, never the raw doc. */
  await Promise.all(out.map(async (r) => {
    const ev = await db.collection(RECEIPTS).doc(r.receiptId).collection('events').limit(50).get();
    r.events = ev.docs.map((d) => {
      const e = d.data() || {};
      const at = e.at && e.at.toMillis ? e.at.toMillis() : (e.at || null);
      return Object.assign({ type: e.type, amountCents: e.amountCents, at },
        e.platformFeeCents != null ? { platformFeeCents: e.platformFeeCents } : {},
        e.providerNetCents != null ? { providerNetCents: e.providerNetCents } : {},
        e.reason ? { reason: e.reason } : {}, e.milestoneId ? { milestoneId: e.milestoneId } : {},
        Array.isArray(e.deductions) && e.deductions.length ? { deductions: e.deductions.map((x) => ({ kind: x.kind, amountCents: x.amountCents })) } : {});
    }).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  }));
  return out;
}

/** Admin search by receipt number, payment reference, source id or party uid. Returns header + position + events. */
async function adminSearch(db, q) {
  const field = q.receiptNo ? 'receiptNo' : q.paymentRef ? 'paymentRef' : q.sourceId ? 'sourceId' : q.clientUid ? 'clientUid' : q.counterpartyId ? 'counterpartyId' : null;
  if (!field) return { ok: false, reason: 'no_query' };
  const snap = await db.collection(RECEIPTS).where(field, '==', String(q[field])).limit(20).get();
  const rows = [];
  for (const doc of snap.docs) {
    const ev = await db.collection(RECEIPTS).doc(doc.id).collection('events').limit(100).get();
    rows.push(Object.assign({ receiptId: doc.id }, doc.data(), { events: ev.docs.map((x) => Object.assign({ eventId: x.id }, x.data())) }));
  }
  return { ok: true, field, receipts: rows };
}

/* ── deployable: the caller's receipts ── */
let myTransactionReceipts, adminSearchReceipts, adminRetryReceiptFailures, retryReceiptFailuresSweep;
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
  const admin = () => require('firebase-admin');
  /* AdminOS read. Admin claim required; EVERY access is audited (who looked at which financial record). Read-only:
     nothing here can rewrite a receipt or an event. */
  adminSearchReceipts = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
    const tk = (req.auth && req.auth.token) || {};
    if (!req.auth || !(tk.admin === true || tk.superAdmin === true)) throw new HttpsError('permission-denied', 'Admins only.');
    const db = admin().firestore();
    const r = await adminSearch(db, req.data || {});
    if (!r.ok) throw new HttpsError('invalid-argument', 'Search by receiptNo, paymentRef, sourceId, clientUid or counterpartyId.');
    await db.collection('adminAudit').add({ action: 'receipt_view', by: req.auth.uid, query: { field: r.field, value: String((req.data || {})[r.field]).slice(0, 160) },
      results: r.receipts.map((x) => x.receiptId).slice(0, 20), createdAt: admin().firestore.FieldValue.serverTimestamp() });
    return r;
  });
  /* Super Admin: replay queued receipt failures now (the daily sweep does the same). Audited. */
  adminRetryReceiptFailures = onCall({ region: 'us-central1', maxInstances: 2 }, async (req) => {
    const tk = (req.auth && req.auth.token) || {};
    if (!req.auth || tk.superAdmin !== true) throw new HttpsError('permission-denied', 'Super Admin only.');
    const db = admin().firestore();
    const out = await retryFailures(db, null, (req.data || {}).limit);
    await db.collection('adminAudit').add({ action: 'receipt_retry', by: req.auth.uid, out, createdAt: admin().firestore.FieldValue.serverTimestamp() });
    return Object.assign({ ok: true }, out);
  });
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  retryReceiptFailuresSweep = onSchedule({ schedule: 'every 6 hours', region: 'us-central1', memory: '256MiB', timeoutSeconds: 300 }, async () => {
    const out = await retryFailures(admin().firestore(), null, 200);
    require('firebase-functions/logger').info('[receipts] retry sweep', out);
  });
}

module.exports = { RECEIPTS, FAILURES, KINDS, TAX, DEDUCTION_KINDS, receiptIdFor, recordPaid, recordEvent, safely, retryFailures, receiptsFor, adminSearch,
  myTransactionReceipts, adminSearchReceipts, adminRetryReceiptFailures, retryReceiptFailuresSweep, _statusOf };
