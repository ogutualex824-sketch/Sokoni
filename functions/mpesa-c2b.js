/* ================================================================
   SOKONI — M-Pesa C2B Validation & Confirmation
   functions/mpesa-c2b.js

   STEP 2 of the payment-engine correction. Completes the leg the platform never
   had: a customer who pays the Paybill MANUALLY (or by scanning a QR) with an
   order reference, rather than being pushed an STK prompt.

       Customer pays Paybill, account = SKNxxxxxxxxx
                 │
            Safaricom
                 │
         ┌───────┴────────┐
     Validation      Confirmation
     (may I?)        (it happened)
                          │
                 paymentIntents/{ref}
                          │
                 verify amount + state
                          │
                 mark intent paid  →  existing reconciler / adapters
                                      pick it up from there

   WHY BillRefNumber IS THE JOIN KEY
   payment-intents.js mints `SKN` + 9 hex server-side (_mintRef). It is
   unguessable, already the reference the STK path carries, and — crucially — it
   is a Paybill ACCOUNT NUMBER. Buy Goods (Till) has no account field at all, so
   reference-based reconciliation is only possible on a Paybill. Matching on
   amount + MSISDN + timestamp instead collides the moment two customers pay the
   same amount within the same minute, which is exactly the ambiguity this
   endpoint exists to remove.

   MONEY MOVEMENT: none. This records and matches payments that Safaricom has
   already settled into whichever shortcode was paid. It does not choose the
   collection account — payment-config.resolveCollectionRoute() owns that.

   SECURITY POSTURE
   Safaricom does NOT sign C2B callbacks, so neither endpoint can authenticate
   its caller cryptographically. Everything therefore assumes the payload is
   attacker-controlled:
     • No amount, payer or status is ever trusted from the body — the figure that
       counts is the one on the server-minted intent.
     • TransID is the idempotency key, claimed with .create() so a replay loses
       the race rather than double-crediting.
     • An optional shared token (settlementConfig/paymentAccounts.c2bToken) is
       compared in constant time when configured, so the URL registered with
       Safaricom can carry a secret an attacker cannot guess. Unset = skipped,
       so onboarding is never blocked by it.
   A forged confirmation still cannot invent money: it can only mark an intent
   paid, which the settlement/reconciliation layer verifies against the M-Pesa
   statement before anyone is paid out.
================================================================ */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const admin         = require('firebase-admin');
const crypto        = require('crypto');

const REGION = 'us-central1';
const _OPTS  = { region: REGION, timeoutSeconds: 30, memory: '256MiB', cors: false };

const db  = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();

/* Safaricom C2B rejection codes (validation only). */
const REJECT_ACCOUNT = 'C2B00012';   // Invalid Account Number
const REJECT_AMOUNT  = 'C2B00013';   // Invalid Amount

/* Safaricom retries a confirmation until it receives success. Retrying cannot
   fix a bug on our side, and an unacknowledged callback is how the same payment
   arrives dozens of times. So confirmation ALWAYS acknowledges; anything we
   could not process is persisted for reconciliation instead of being bounced. */
const ACK = { ResultCode: 0, ResultDesc: 'Success' };

function _num(v) { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) ? n : NaN; }
function _ref(v) { return String(v ?? '').trim().toUpperCase(); }

/* Constant-time compare so the token cannot be discovered by timing. */
function _tokenOk(supplied, expected) {
  if (!expected) return true;                       // not configured → skip
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Timeline marks must never break a payment callback, and must only use stages
   payment-timeline actually knows — an unregistered stage is discarded. */
function _mark(ref, stage, data) {
  if (!ref) return;
  try {
    const timeline = require('./payment-timeline');
    if (timeline && typeof timeline.mark === 'function') timeline.mark(ref, stage, data || {});
  } catch (_) {}
}

async function _config() {
  try {
    const s = await db().doc('settlementConfig/paymentAccounts').get();
    return s.exists ? (s.data() || {}) : {};
  } catch (_) { return {}; }
}

/* Normalise Safaricom's payload once, so both endpoints read the same shape. */
function _parse(body) {
  const b = body || {};
  return {
    transId:     String(b.TransID || '').trim(),
    transTime:   String(b.TransTime || '').trim(),
    amount:      _num(b.TransAmount),
    shortCode:   String(b.BusinessShortCode || '').trim(),
    billRef:     _ref(b.BillRefNumber),
    invoice:     String(b.InvoiceNumber || '').trim() || null,
    msisdn:      String(b.MSISDN || '').trim(),
    payerName:   [b.FirstName, b.MiddleName, b.LastName].filter(Boolean).join(' ').trim() || null,
    txnType:     String(b.TransactionType || '').trim() || null,
  };
}

/* ────────────────────────────────────────────────────────────────
   VALIDATION — "may this payment proceed?"
   Only enabled on the Paybill if SOKONI opts into external validation with
   Safaricom. Rejecting here stops the customer's money before it moves, so the
   bar for rejection is deliberately high: reject only when the reference is
   definitively not ours or the amount definitively disagrees.

   FAILS OPEN on our own errors. If Firestore is unavailable we ACCEPT: the
   alternative is declining a paying customer because of an outage on our side.
   The confirmation callback still arrives, and an unmatched payment is recorded
   rather than lost.
──────────────────────────────────────────────────────────────── */
exports.mpesaC2BValidation = onRequest(_OPTS, async (req, res) => {
  const p = _parse(req.body);
  try {
    const cfg = await _config();
    if (!_tokenOk(req.query && req.query.t, cfg.c2bToken)) {
      /* Wrong/absent token on a configured endpoint: do not disclose why. */
      res.status(200).json({ ResultCode: REJECT_ACCOUNT, ResultDesc: 'Invalid account number' });
      return;
    }

    if (!/^SKN[0-9A-F]{9}$/.test(p.billRef)) {
      res.status(200).json({ ResultCode: REJECT_ACCOUNT, ResultDesc: 'Unknown reference' });
      return;
    }

    const snap = await db().collection('paymentIntents').doc(p.billRef).get();
    if (!snap.exists) {
      res.status(200).json({ ResultCode: REJECT_ACCOUNT, ResultDesc: 'Unknown reference' });
      return;
    }
    const intent = snap.data() || {};

    /* Underpayment is rejected; overpayment is allowed through and reconciled,
       because refusing money already tendered creates a worse support problem
       than recording a credit. */
    const expected = _num(intent.amount);
    if (Number.isFinite(expected) && Number.isFinite(p.amount) && p.amount + 1 < expected) {
      res.status(200).json({ ResultCode: REJECT_AMOUNT, ResultDesc: 'Amount is less than the amount due' });
      return;
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('[c2bValidation] accepting despite internal error', { ref: p.billRef, err: err && err.message });
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

/* ────────────────────────────────────────────────────────────────
   CONFIRMATION — "this payment happened."
   Money has already moved. The job is to attach it to the right intent exactly
   once, and to make sure it is never silently dropped.
──────────────────────────────────────────────────────────────── */
exports.mpesaC2BConfirmation = onRequest(_OPTS, async (req, res) => {
  const p = _parse(req.body);

  try {
    const cfg = await _config();
    if (!_tokenOk(req.query && req.query.t, cfg.c2bToken)) {
      /* Acknowledge (never invite a retry storm) but record and do nothing. */
      await db().collection('c2bRejected').add({
        reason: 'bad_token', transId: p.transId || null, billRef: p.billRef || null,
        amount: Number.isFinite(p.amount) ? p.amount : null, createdAt: _ts(),
      }).catch(() => {});
      res.status(200).json(ACK);
      return;
    }

    if (!p.transId) {
      await db().collection('c2bRejected').add({
        reason: 'missing_transid', raw: JSON.stringify(req.body || {}).slice(0, 900), createdAt: _ts(),
      }).catch(() => {});
      res.status(200).json(ACK);
      return;
    }

    /* ── IDEMPOTENCY ──────────────────────────────────────────────
       M-Pesa's TransID is unique per transaction, so it is the natural key.
       .create() throws if the document exists, which makes the claim atomic:
       a retry or a replay loses the race and is logged rather than applied a
       second time. Recording the event BEFORE any mutation means a crash
       mid-processing still leaves a durable trace to reconcile from. */
    const eventRef = db().collection('c2bEvents').doc(p.transId);
    try {
      await eventRef.create({
        transId: p.transId, billRef: p.billRef || null, shortCode: p.shortCode || null,
        amount: Number.isFinite(p.amount) ? p.amount : null,
        msisdn: p.msisdn || null, payerName: p.payerName || null,
        transTime: p.transTime || null, txnType: p.txnType || null,
        status: 'received', createdAt: _ts(),
      });
    } catch (_) {
      console.log('[c2bConfirmation] duplicate ignored', { transId: p.transId });
      await eventRef.set({ duplicateSeenAt: _ts() }, { merge: true }).catch(() => {});
      res.status(200).json(ACK);
      return;
    }

    /* ── MATCH ───────────────────────────────────────────────────
       No intent for this reference means the money is real but unattributed
       (mistyped account, or a payment for something never initiated here).
       It goes to unmatchedPayments so operations can find it — money must never
       simply vanish because it did not fit a lookup. */
    const validRef = /^SKN[0-9A-F]{9}$/.test(p.billRef);
    const snap = validRef ? await db().collection('paymentIntents').doc(p.billRef).get() : null;

    if (!snap || !snap.exists) {
      await db().collection('unmatchedPayments').doc(p.transId).set({
        transId: p.transId, billRef: p.billRef || null,
        amount: Number.isFinite(p.amount) ? p.amount : null,
        msisdn: p.msisdn || null, payerName: p.payerName || null,
        shortCode: p.shortCode || null,
        reason: validRef ? 'no_intent_for_reference' : 'reference_not_recognised',
        resolved: false, createdAt: _ts(),
      });
      await eventRef.set({ status: 'unmatched' }, { merge: true }).catch(() => {});
      _mark(p.billRef, 'webhook_rejected', { transId: p.transId, reason: 'unmatched', channel: 'mpesa_c2b' });
      res.status(200).json(ACK);
      return;
    }

    const intent = snap.data() || {};
    const expected = _num(intent.amount);
    const paid     = p.amount;

    /* ── AMOUNT ──────────────────────────────────────────────────
       The authority is the server-minted intent, never the callback. A payment
       that does not match is recorded and left for a human — marking it paid on
       the customer's say-so is precisely how a ledger stops matching reality. */
    if (Number.isFinite(expected) && Number.isFinite(paid) && Math.abs(paid - expected) > 1) {
      await db().collection('paymentExceptions').doc(p.transId).set({
        type: paid < expected ? 'underpayment' : 'overpayment',
        transId: p.transId, ref: p.billRef, expected, paid,
        msisdn: p.msisdn || null, ownerUid: intent.ownerUid || null,
        resolved: false, createdAt: _ts(),
      });
      await eventRef.set({ status: 'amount_mismatch' }, { merge: true }).catch(() => {});
      _mark(p.billRef, 'webhook_rejected', {
        transId: p.transId, reason: 'amount_mismatch', expected, paid, channel: 'mpesa_c2b',
      });
      res.status(200).json(ACK);
      return;
    }

    /* ── APPLY ───────────────────────────────────────────────────
       Claim the intent transactionally. An intent already in a paid/terminal
       state is left untouched: two callbacks for the same reference must credit
       once. C2B lands in whichever shortcode the customer paid, so the route is
       recorded as observed rather than inferred from config. */
    let applied = false;
    await db().runTransaction(async (txn) => {
      const cur = await txn.get(snap.ref);
      if (!cur.exists) return;
      const d = cur.data() || {};
      if (d.status === 'paid' || d.status === 'completed' || d.status === 'cancelled') return;
      txn.update(snap.ref, {
        status:            'paid',
        paidAt:            _ts(),
        paidAmount:        Number.isFinite(paid) ? paid : null,
        mpesaReceipt:      p.transId,
        payerMsisdn:       p.msisdn || null,
        payerName:         p.payerName || null,
        paymentChannel:    'mpesa_c2b',
        collectionShortCode: p.shortCode || null,
        collectionRoute:   'CENTRAL_MOR',
        updatedAt:         _ts(),
      });
      applied = true;
    });

    await eventRef.set({
      status: applied ? 'applied' : 'already_settled',
      ref: p.billRef, ownerUid: intent.ownerUid || null,
    }, { merge: true }).catch(() => {});

    /* Observability through the EXISTING timeline vocabulary, so a C2B payment
       reads the same way as an STK one on the same dashboards. Deliberately
       reuses payment-timeline's canonical STAGES rather than inventing C2B-only
       names — the first draft did invent them and the timeline silently dropped
       every mark ("unknown stage ignored"), which is worse than no telemetry
       because it looks like the payment never happened. Never fails the callback. */
    _mark(p.billRef, applied ? 'webhook_verified' : 'webhook_received', {
      transId: p.transId, amount: paid, msisdn: p.msisdn || null, channel: 'mpesa_c2b',
    });

    await db().collection('auditLogs').add({
      type: 'mpesa_c2b_confirmation', transId: p.transId, ref: p.billRef,
      amount: Number.isFinite(paid) ? paid : null, applied,
      ownerUid: intent.ownerUid || null, createdAt: _ts(),
    }).catch(() => {});

    res.status(200).json(ACK);
  } catch (err) {
    /* Acknowledge and persist. Bouncing the callback would have Safaricom retry
       a payload we already failed on, and the retry would fail the same way. */
    console.error('[c2bConfirmation] internal error', { transId: p.transId, err: err && err.message });
    await db().collection('c2bRejected').add({
      reason: 'internal_error', transId: p.transId || null, billRef: p.billRef || null,
      error: String((err && err.message) || err).slice(0, 400), createdAt: _ts(),
    }).catch(() => {});
    res.status(200).json(ACK);
  }
});
