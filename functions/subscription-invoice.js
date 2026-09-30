/* ================================================================
   SOKONI — Subscription platform invoice (ONE invoice authority, consumed)
   ----------------------------------------------------------------
   A subscription payment is platform revenue (RATES.subscriptions = 100%): SOKONI is
   the payee, so SOKONI issues the fiscal invoice. Until 2026-09-30 no subscription
   payment produced one on any lineage — the only platform-invoice implementation,
   `etims._issuePlatformInvoice`, was reachable for fee type "subscription" solely
   through the admin callable. This module connects the FINALIZED transaction to that
   one engine. It creates no second invoice engine, no second amount, no new store.

       payments/{ref}         status COMPLETE, meta.purpose 'subscription'   (webhook path)
       paymentIntents/{ref}   status 'paid',   purpose 'subscription'        (intent rails)
                │   the amount is READ from the finalized record — never recomputed
                ▼
       finosIdempotency/sub_invoice_{ref}     ← the claim (transaction; issuing/issued/deferred/failed)
                │
                ▼
       etims._issuePlatformInvoice({ feeType: 'subscription', reference: ref })
                │   engine key `platform-subscription-{ref}` — second line of idempotency
                ▼
       etimsInvoices/{id}   →   {source}.platformInvoiceId · billingHistory.platformInvoiceId

   INVARIANTS
   1. The amount comes from the finalized transaction, never from a caller or a catalogue.
   2. Invoicing never gates entitlement. A missing VAT decision or a KRA failure leaves the
      subscription active and the claim `deferred` / `failed`; the daily sweep retries.
   3. The VAT treatment is never inferred. `revenueConfig/subscription_vat` must be set by
      the business (same fail-closed contract as commission_vat); unset ⇒ defer, not guess.
   4. One invoice per payment reference, however many writers activate on it: the claim is
      taken inside a Firestore transaction and the engine key is deterministic.
   ================================================================ */
'use strict';

const { onSchedule }          = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const logger                  = require('firebase-functions/logger');
const admin                   = require('firebase-admin');
const { loadVatPolicy, SUBSCRIPTION_POLICY_DOC, SUBSCRIPTION_UNSET_REASON } = require('./commission-vat-policy');

const REGION    = 'us-central1';
const CLAIMS    = 'finosIdempotency';
const KIND      = 'subscription_invoice';
const FEE_TYPE  = 'subscription';
const STALE_MS  = 10 * 60 * 1000;          /* an `issuing` claim older than this is retryable */
const SWEEP_LIMIT = 200;

const _db  = () => admin.firestore();
const _FV  = () => admin.firestore.FieldValue;
const _claimId = (ref) => `sub_invoice_${ref}`;

/* ── 1. the finalized transaction ─────────────────────────────────────────────────────── */
async function _finalizedSubscriptionPayment(db, ref) {
  const [p, i] = await Promise.all([
    db.collection('payments').doc(ref).get(),
    db.collection('paymentIntents').doc(ref).get(),
  ]);
  if (p.exists) {
    const d = p.data() || {};
    const meta = d.meta || {};
    if (String(d.status || '').toUpperCase() === 'COMPLETE' && meta.purpose === 'subscription') {
      return {
        source: 'payments', uid: meta.uid || d.uid || null,
        amountKES: Number(d.amount),
        planId: meta.planId || null, billingCycle: meta.billingCycle || null,
        hubType: meta.hubType || null, planName: meta.planName || null,
      };
    }
  }
  if (i.exists) {
    const d = i.data() || {};
    if (d.status === 'paid' && (!d.purpose || d.purpose === 'subscription')) {
      const kes = Number.isFinite(Number(d.amount)) && Number(d.amount) > 0
        ? Number(d.amount)
        : Number(d.amountCents) / 100;
      return {
        source: 'paymentIntents', uid: d.uid || null,
        amountKES: kes,
        planId: d.planId || null, billingCycle: d.billingCycle || null,
        hubType: d.hubType || null, planName: d.planName || null,
      };
    }
  }
  return null;
}

/* ── 2. the claim — one issuer per reference, retryable on failure ────────────────────── */
async function _claim(db, ref) {
  const cref = db.collection(CLAIMS).doc(_claimId(ref));
  return db.runTransaction(async (t) => {
    const s = await t.get(cref);
    const nowMs = Date.now();
    if (!s.exists) {
      t.set(cref, {
        kind: KIND, ref, status: 'issuing', subInvoicePending: true, attempts: 1,
        issuingSinceMs: nowMs, createdAt: _FV().serverTimestamp(), updatedAt: _FV().serverTimestamp(),
      });
      return { granted: true, first: true };
    }
    const d = s.data() || {};
    if (d.status === 'issued') return { granted: false, reason: 'already_issued', invoiceId: d.invoiceId || null };
    if (d.status === 'issuing' && nowMs - Number(d.issuingSinceMs || 0) < STALE_MS) {
      return { granted: false, reason: 'in_flight' };
    }
    t.update(cref, {
      status: 'issuing', issuingSinceMs: nowMs, attempts: _FV().increment(1),
      updatedAt: _FV().serverTimestamp(),
    });
    return { granted: true, first: false, previous: d.status || null };
  });
}

async function _settle(db, ref, patch) {
  await db.collection(CLAIMS).doc(_claimId(ref)).set(
    { ...patch, updatedAt: _FV().serverTimestamp() }, { merge: true });
}

function _describe(tx) {
  const plan  = tx.planName || tx.planId || 'subscription';
  const cycle = tx.billingCycle ? ` (${tx.billingCycle})` : '';
  const hub   = tx.hubType ? ` — ${tx.hubType}` : '';
  return `${plan}${cycle}${hub}`.slice(0, 120);
}

/* ── 3. issue — the only function that talks to the engine ────────────────────────────── */
async function issueForSubscriptionPayment(paymentRef, { actor = 'system' } = {}) {
  const ref = String(paymentRef || '').trim().slice(0, 128);
  if (!ref || ref === 'free') return { ok: false, reason: 'no_payment_ref' };
  const db = _db();

  const tx = await _finalizedSubscriptionPayment(db, ref);
  if (!tx)                       return { ok: false, reason: 'no_finalized_subscription_payment' };
  if (!tx.uid)                   return { ok: false, reason: 'no_uid_on_payment' };
  if (!(tx.amountKES > 0))       return { ok: false, reason: 'no_amount_on_payment' };

  const claim = await _claim(db, ref);
  if (!claim.granted) {
    return { ok: claim.reason === 'already_issued', reason: claim.reason, invoiceId: claim.invoiceId || null, idempotent: true };
  }

  const policy = await loadVatPolicy(db, SUBSCRIPTION_POLICY_DOC);
  if (!policy) {
    await _settle(db, ref, { status: 'deferred', reason: 'vat_policy_unset', subInvoicePending: true, source: tx.source, uid: tx.uid, amountKES: tx.amountKES });
    return { ok: false, deferred: true, reason: 'vat_policy_unset', detail: SUBSCRIPTION_UNSET_REASON };
  }

  let result;
  try {
    const etims = require('./etims');
    result = await etims._issuePlatformInvoice({
      sellerUid: tx.uid, feeType: FEE_TYPE, amount: tx.amountKES, reference: ref,
      description: _describe(tx), vatInclusive: policy.inclusive, taxCategory: policy.taxCategory,
    });
  } catch (err) {
    await _settle(db, ref, { status: 'failed', reason: 'invoice_engine_failed', error: String(err && err.message || err).slice(0, 200), subInvoicePending: true, source: tx.source, uid: tx.uid, amountKES: tx.amountKES });
    logger.error('[subscription-invoice] engine failed', { ref, actor, err: String(err && err.message || err).slice(0, 200) });
    return { ok: false, reason: 'invoice_engine_failed', error: String(err && err.message || err).slice(0, 200) };
  }

  const invoiceId = result && result.invoiceId ? String(result.invoiceId) : null;
  if (!invoiceId) {
    await _settle(db, ref, { status: 'failed', reason: 'no_invoice_id_returned', subInvoicePending: true, source: tx.source, uid: tx.uid, amountKES: tx.amountKES });
    return { ok: false, reason: 'no_invoice_id_returned' };
  }

  await _settle(db, ref, {
    status: 'issued', invoiceId, subInvoicePending: _FV().delete(), reason: _FV().delete(), error: _FV().delete(),
    source: tx.source, uid: tx.uid, amountKES: tx.amountKES, vatInclusive: policy.inclusive, taxCategory: policy.taxCategory,
    vatDecidedBy: policy.decidedBy, issuedAt: _FV().serverTimestamp(), engineDuplicate: result.duplicate === true,
  });

  /* Back-references — best effort, never part of the claim. */
  const back = { platformInvoiceId: invoiceId, platformInvoicedAt: _FV().serverTimestamp() };
  await db.collection(tx.source).doc(ref).set(back, { merge: true }).catch(() => null);
  try {
    const bh = await db.collection('billingHistory').where('paymentRef', '==', ref).limit(5).get();
    await Promise.all(bh.docs.map((d) => d.ref.set(back, { merge: true })));
  } catch (_) { /* billingHistory is a journal, not the claim */ }

  logger.info('[subscription-invoice] issued', { ref, actor, invoiceId, amountKES: tx.amountKES, vatInclusive: policy.inclusive, source: tx.source, engineDuplicate: result.duplicate === true });
  return { ok: true, invoiceId, amountKES: tx.amountKES, vatInclusive: policy.inclusive, source: tx.source, engineDuplicate: result.duplicate === true };
}

/* ── 4. the hook every activation writer calls — never throws, never gates entitlement ── */
async function recordAfterActivation(paymentRef, ctx = {}) {
  try {
    const r = await issueForSubscriptionPayment(paymentRef, { actor: ctx.actor || 'activation' });
    if (!r.ok && !r.deferred && !r.idempotent) {
      logger.warn('[subscription-invoice] not issued after activation', { ref: paymentRef, actor: ctx.actor, reason: r.reason });
    }
    return r;
  } catch (err) {
    logger.error('[subscription-invoice] hook crashed (entitlement unaffected)', { ref: paymentRef, actor: ctx.actor, err: String(err && err.message || err).slice(0, 200) });
    return { ok: false, reason: 'hook_crashed' };
  }
}

/* ── 5. the sweep — deferred / failed / stale claims are retried daily ─────────────────── */
async function sweepPending({ limit = SWEEP_LIMIT, actor = 'sweep' } = {}) {
  const snap = await _db().collection(CLAIMS).where('subInvoicePending', '==', true).limit(limit).get();
  const out = { scanned: snap.size, issued: 0, deferred: 0, failed: 0, skipped: 0 };
  for (const d of snap.docs) {
    const ref = (d.data() || {}).ref;
    if (!ref) { out.skipped++; continue; }
    const r = await issueForSubscriptionPayment(ref, { actor });
    if (r.ok) out.issued++;
    else if (r.deferred) out.deferred++;
    else if (r.idempotent) out.skipped++;
    else out.failed++;
  }
  logger.info('[subscription-invoice] sweep', out);
  return out;
}

exports.subIssuePendingInvoices = onSchedule(
  { schedule: 'every 24 hours', region: REGION, memory: '256MiB', timeoutSeconds: 540 },
  async () => { await sweepPending(); }
);

/* Admin re-issue / first issue for one reference. Admins only; the amount is still read
   from the finalized transaction — the caller names the reference and nothing else. */
exports.subIssueInvoice = onCall(
  { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 },
  async (request) => {
    const token = (request.auth && request.auth.token) || {};
    if (!request.auth || !(token.admin === true || token.superAdmin === true)) {
      throw new HttpsError('permission-denied', 'Admins only.');
    }
    const { paymentRef } = request.data || {};
    const res = await issueForSubscriptionPayment(paymentRef, { actor: request.auth.uid });
    if (!res.ok && res.reason === 'vat_policy_unset') throw new HttpsError('failed-precondition', res.detail);
    return res;
  }
);

module.exports.issueForSubscriptionPayment = issueForSubscriptionPayment;
module.exports.recordAfterActivation       = recordAfterActivation;
module.exports.sweepPending                = sweepPending;
module.exports._internal = { _finalizedSubscriptionPayment, _claim, _claimId, _describe, KIND, FEE_TYPE, STALE_MS };
