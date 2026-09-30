'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — POS/TILL COMMISSION SETTLEMENT FROM THE VERIFIED WEBHOOK
   functions/pos-commission-settlement.js

   The 07:00 gate computes what a merchant owes. The rail asks IntaSend to collect it.
   This is the only thing that may say it was collected.

       IntaSend webhook
              │
              ▼
       api_ref = poscollect_<sellerId>_<period>      the attempt's own idempotency key
              │
              ▼
       posCommissionCollections/<sellerId>_<period>  the stored intent
              │
              ▼
       verify: reference · currency · EXACT amount · settled state
              │
              ▼
       ONE transaction:  ledger TYPE_COLLECTED  +  attempt -> confirmed
              │
              ▼
       outstanding = accrued − collected           reduced by exactly the verified amount

   WHY SETTLEMENT LIVES HERE AND NOT IN THE RAIL

   The rail can only report that it ASKED. It has not seen the money, and IntaSend
   answering "accepted" — or even "COMPLETE" — on an initiation response is not proof
   that a customer paid. Letting the rail settle would be a browser saying "payment
   confirmed" with a server's return address on it.

   THE ACCOUNTING INVARIANT, AND WHY IT HOLDS BY CONSTRUCTION

       previous outstanding − verified settlement = new outstanding

   `outstandingForSeller` derives from the ledger (accrued minus collected), never from
   a cached balance. So writing the TYPE_COLLECTED entry IS the reduction — there is no
   second counter to update and therefore none to drift. A settlement that wrote a
   balance field instead would be a second source of truth for the same fact.

   WHAT REFUSAL MEANS: NOTHING MOVES. A mismatch, an unknown state, an unknown
   reference — every one of them leaves the ledger untouched and the receivable
   outstanding, and records WHY on the attempt so the debt stays visible in the
   worklist instead of quietly disappearing from it.
   ══════════════════════════════════════════════════════════════════════════════ */

const AUTH = require('./intasend-authority');

const C_ATTEMPTS = 'posCommissionCollections';
const PREFIX = 'poscollect_';

/* Attempt ids are `<sellerId>_<period>`; the reference the rail sends is
   `poscollect_<sellerId>_<period>`. One is derived from the other, so no lookup table
   exists to fall out of step with either. */
function attemptIdFromRef(apiRef) {
  const s = String(apiRef || '').trim();
  if (!s.startsWith(PREFIX)) return null;
  const rest = s.slice(PREFIX.length);
  return rest || null;
}

function isCommissionRef(apiRef) { return attemptIdFromRef(apiRef) !== null; }

/**
 * Apply a webhook to a POS commission collection attempt.
 *
 * Returns { applied, outcome, reason?, sellerId?, amountCents?, actualMethod? }.
 * `applied:false` with no reason means the payload simply is not ours — the caller
 * must treat that as "not handled here", never as a failure.
 */
async function applyWebhook(db, payload, opts) {
  const options = opts || {};
  const inv = (payload && (payload.invoice || payload)) || {};
  const apiRef = String(inv.api_ref || (payload && payload.api_ref) || '').trim();

  const attemptId = attemptIdFromRef(apiRef);
  if (!attemptId) return { applied: false, outcome: 'not_ours' };

  const ref = db.collection(C_ATTEMPTS).doc(attemptId);
  const snap = await ref.get();
  if (!snap.exists) {
    /* An UNKNOWN reference is refused, not invented. Creating an attempt here would let
       a forged payload manufacture a collection against a merchant who was never billed. */
    return { applied: false, outcome: 'refused', reason: 'UNKNOWN_REFERENCE', apiRef };
  }
  const attempt = snap.data() || {};

  /* Already settled — a redelivered webhook must not collect twice. Checked here for a
     cheap exit and AGAIN inside the transaction, where it is the actual guarantee. */
  if (attempt.state === 'confirmed') {
    return { applied: false, outcome: 'already_settled', sellerId: attempt.sellerId || null, apiRef };
  }

  /* The stored intent. The amount is the obligation the gate computed and the rail was
     handed; the currency is what the rail was configured with. Neither is taken from the
     payload — that is the whole point of a match. */
  const intent = {
    ref: apiRef,
    money: {
      currency: String(attempt.currency || options.defaultCurrency || '').toUpperCase(),
      minor: Number.isInteger(attempt.amountCents) ? attempt.amountCents : NaN,
    },
  };
  if (!intent.money.currency) {
    return { applied: false, outcome: 'refused', reason: 'ATTEMPT_HAS_NO_CURRENCY', apiRef };
  }

  const verdict = AUTH.verifyProviderResult({ intent, payload });
  if (!verdict.ok) {
    /* Recorded on the attempt so the refusal is visible, and NOTHING else changes. */
    await ref.update({
      lastWebhookRefusal: {
        reason: verdict.reason,
        detail: verdict.detail || null,
        state: verdict.state || null,
        at: new Date().toISOString(),
      },
    }).catch(() => {});
    return { applied: false, outcome: 'refused', reason: verdict.reason,
             detail: verdict.detail || null, sellerId: attempt.sellerId || null, apiRef };
  }

  /* The tender that actually paid. CASH can never arrive here — the authority refuses it
     at the boundary — but asserting it makes the impossibility explicit rather than
     inherited. */
  const tender = AUTH.assertProviderTender(verdict.actualMethod);
  if (!tender.ok) {
    await ref.update({
      lastWebhookRefusal: { reason: 'NON_PROVIDER_TENDER', detail: verdict.actualMethod,
                            at: new Date().toISOString() },
    }).catch(() => {});
    return { applied: false, outcome: 'refused', reason: 'NON_PROVIDER_TENDER',
             detail: verdict.actualMethod, apiRef };
  }

  const FU = require('./finos-utils');
  const sellerId = String(attempt.sellerId || '');
  const period = String(attempt.period || '');
  const amountCents = verdict.money.minor;

  /* ── the settling write ──────────────────────────────────────────────────────
     The ledger entry carries the attempt's idempotency key, and createLedgerEntry
     enforces its own idempotency on it, so a duplicate confirmation books once. The
     attempt transition is claimed in a transaction so two concurrent redeliveries
     cannot both pass the "already confirmed?" check. */
  let claimed = false;
  await db.runTransaction(async (t) => {
    const fresh = await t.get(ref);                       /* read before any write */
    if (!fresh.exists) return;
    if ((fresh.data() || {}).state === 'confirmed') return;
    claimed = true;
    t.update(ref, {
      state: 'confirmed',
      railRef: verdict.providerTrackingId || null,
      settledMethod: tender.method,                       /* the ACTUAL method, from the payload */
      settledCurrency: verdict.money.currency,
      settledAmountCents: amountCents,
      providerFeeMinor: verdict.providerFeeMinor === null ? null : verdict.providerFeeMinor,
      confirmedAt: new Date().toISOString(),
      confirmedBy: 'intasend-webhook',
    });
  });

  if (!claimed) {
    return { applied: false, outcome: 'already_settled', sellerId, apiRef };
  }

  /* The money entry. Written after the claim: if this throws, the attempt is confirmed
     with no ledger row, which reconciliation surfaces as a discrepancy — the visible
     failure. The opposite order would book money against an unclaimed attempt and could
     book it twice. */
  await FU.createLedgerEntry(db, {
    type: 'pos_commission_collected',
    amountCents,
    /* The debit account follows the method that ACTUALLY paid. Hardcoding an M-PESA
       account would file a card collection against a rail the money never used. */
    debitAccount: _externalAccountFor(FU, tender.method),
    creditAccount: FU.ACCOUNTS ? FU.ACCOUNTS.seller(sellerId) : ('seller:' + sellerId),
    description: 'POS commission collected for ' + period + ' via ' + tender.method,
    sellerId,
    category: 'pos',
    createdBy: 'posCommissionSettlement',
    idempotencyKey: apiRef,
    metadata: {
      period,
      railId: attempt.railId || 'intasend',
      railRef: verdict.providerTrackingId || null,
      method: tender.method,
      currency: verdict.money.currency,
      providerFeeMinor: verdict.providerFeeMinor,
      receivableIds: attempt.receivableIds || [],
    },
  });

  return {
    applied: true, outcome: 'settled', sellerId, period,
    amountCents, actualMethod: tender.method,
    currency: verdict.money.currency, apiRef,
  };
}

/* External account per rail, mapped ONLY onto accounts the finos chart already
   defines. The chart has EXTERNAL_MPESA, EXTERNAL_BANK and EXTERNAL_GATEWAY but no card
   account, so card money books to the gateway — inventing a chart entry here would be an
   accounting decision made by a wiring change.

   The distinction is not lost: the ACTUAL method is recorded on the attempt as
   settledMethod and on the ledger entry metadata, so a card collection is identifiable
   even where the chart does not give it its own account. */
function _externalAccountFor(FU, method) {
  const A = (FU && FU.ACCOUNTS) || {};
  const byMethod = {
    MPESA: A.EXTERNAL_MPESA || 'external:mpesa',
    BANK:  A.EXTERNAL_BANK  || 'external:bank',
    CARD:  A.EXTERNAL_GATEWAY || 'external:gateway',
  };
  return byMethod[method] || A.EXTERNAL_GATEWAY || 'external:gateway';
}

module.exports = { applyWebhook, isCommissionRef, attemptIdFromRef, C_ATTEMPTS, PREFIX };
