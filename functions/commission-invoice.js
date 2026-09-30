/* ================================================================
   SOKONI — 48-hour commission invoice generator

   Connects an existing receivable to the existing invoice engine. It creates
   NOTHING new: no collection, no settlement engine, no commission calculator,
   no escrow states.

       commissionLedger/{id}          ← AUTHORITATIVE. the amount lives here.
         billingModel: PER_SALE_48H
         collectionStatus: DUE
         invoiceId: null              ← field already existed; we populate it
              │
              ▼
       etims._issuePlatformInvoice()  ← the ONE platform-invoice implementation
              │
              ▼
       etimsInvoices/{invoiceId}      ← KRA-fiscalised, immutable
              │
              ▼
       commissionLedger.invoiceId     ← the only field this module ever writes

   THREE INVARIANTS, EACH LOAD-BEARING

   1. THE AMOUNT COMES FROM THE LEDGER, NEVER FROM A CALLER.
      `etimsPlatformInvoice` takes `amount` from `req.data`. That is how an
      invoice can disagree with the receivable it is supposedly for. Here the
      caller may only name the receivable; the amount is read from it.

   2. A FISCALISATION FAILURE DOES NOT ALTER THE OBLIGATION.
      The receivable arises from buyer-attested order completion
      (COMMISSION_ENFORCEMENT_CONTRACT §6a), not from a document. If KRA rejects
      or times out, the merchant still owes the money. This module never writes
      collectionStatus, totalOwed, totalOutstanding or dueAt — on any path.

   3. THE VAT TREATMENT IS NEVER INFERRED.
      TaxEngine treats an absent config as inclusive. Passing nothing would let a
      library default answer an open tax question. Policy comes from
      revenueConfig/commission_vat and is fail-closed: unset ⇒ refuse to issue.

   Scope: nothing here touches Daraja, STK, C2B, productionAuthorized, the POS
   release, or commissionSettlements.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const { loadVatPolicy, UNSET_REASON } = require('./commission-vat-policy');

const db     = getFirestore();
const REGION = 'us-central1';

const LEDGER   = 'commissionLedger';
const BILLING  = 'PER_SALE_48H';
const FEE_TYPE = 'commission';

/* A receivable may be invoiced while it is outstanding. PAID and WAIVED are
   terminal — invoicing a settled or forgiven obligation would bill it twice. */
const INVOICEABLE = ['DUE', 'REMINDED', 'OVERDUE'];

/**
 * Issue the commission invoice for one 48-hour receivable.
 *
 * Returns a plain result rather than throwing on business refusals, so a batch
 * caller can continue past one bad row. Genuinely exceptional failures still
 * throw.
 */
async function issueForReceivable(ledgerRowId, { actor = 'system' } = {}) {
  if (!ledgerRowId) return { ok: false, reason: 'missing_ledger_row_id' };

  const ref  = db.collection(LEDGER).doc(String(ledgerRowId));
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: 'receivable_not_found' };

  const d = snap.data() || {};

  /* ── Eligibility ─────────────────────────────────────────────────────── */
  if (d.billingModel !== BILLING)      return { ok: false, reason: 'not_48h_billing_model' };
  if (d.invoiceId)                     return { ok: true,  reason: 'already_invoiced',
                                                invoiceId: d.invoiceId, idempotent: true };
  if (!INVOICEABLE.includes(d.collectionStatus))
    return { ok: false, reason: 'not_invoiceable', collectionStatus: d.collectionStatus || null };

  const sellerUid = d.sellerUid || d.uid || null;
  if (!sellerUid) return { ok: false, reason: 'no_seller_on_receivable' };

  /* ── INVARIANT 1: the amount is read, never accepted ──────────────────
     totalOutstanding includes any assessed penalty and is what the merchant
     actually owes; totalOwed is the bare commission. Prefer the former, fall
     back to the latter, and refuse rather than invoice a zero. */
  const amountKES = Number(d.totalOutstanding ?? d.totalOwed ?? 0);
  if (!(amountKES > 0)) return { ok: false, reason: 'no_amount_on_receivable' };

  /* ── INVARIANT 3: policy or nothing ──────────────────────────────────── */
  const policy = await loadVatPolicy(db);
  if (!policy) return { ok: false, reason: 'vat_policy_unset', detail: UNSET_REASON };

  /* ── Issue via the ONE platform-invoice implementation ────────────────
     `reference` is the ledger row id, which makes the engine's existing
     `platform-commission-{reference}` idempotency key deterministic: one invoice
     per receivable, and a retry returns the first one. */
  let result;
  try {
    const etims = require('./etims');
    result = await etims._issuePlatformInvoice({
      sellerUid,
      feeType:     FEE_TYPE,
      amount:      amountKES,
      reference:   String(ledgerRowId),
      description: _describe(d),
      vatInclusive: policy.inclusive,
      taxCategory:  policy.taxCategory,     /* standard | zero_rated | exempt — from the policy, never inferred */
    });
  } catch (err) {
    /* ── INVARIANT 2 ────────────────────────────────────────────────────
       The receivable is untouched. The merchant still owes this money; only
       the document failed. */
    console.error(`[commission-invoice] issue failed row=${ledgerRowId}: ${err.message}`);
    return { ok: false, reason: 'invoice_engine_failed', error: err.message, receivableUnchanged: true };
  }

  const invoiceId = result && (result.invoiceId || null);
  if (!invoiceId) {
    return { ok: false, reason: 'no_invoice_id_returned', receivableUnchanged: true };
  }

  /* ── The only write this module makes to the receivable ───────────────
     A targeted update, not a merge of a wider object: it must be impossible for
     this path to alter collectionStatus or any amount. The guard re-checks
     inside a transaction so two concurrent runs cannot both claim the row. */
  const claimed = await db.runTransaction(async (txn) => {
    const cur = await txn.get(ref);
    if (!cur.exists) return false;
    if (cur.data().invoiceId) return false;      /* another run won */
    txn.update(ref, {
      invoiceId,
      invoicedAt:        FieldValue.serverTimestamp(),
      invoiceVatInclusive: policy.inclusive,     /* what it was issued under */
      invoiceTaxCategory:  policy.taxCategory,
      invoiceVatDecidedBy: policy.decidedBy,
    });
    return true;
  });

  console.log(`[commission-invoice] row=${ledgerRowId} invoice=${invoiceId} ` +
              `amount=${amountKES} vatInclusive=${policy.inclusive} claimed=${claimed} actor=${actor}`);

  return { ok: true, reason: claimed ? 'invoiced' : 'already_invoiced_concurrently',
           invoiceId, amountKES, vatInclusive: policy.inclusive };
}

/** Human-readable line description. Never used for arithmetic. */
function _describe(d) {
  const pct  = d.commissionPct != null ? `${d.commissionPct}%` : 'commission';
  const gross = Number(d.grossAmount || 0);
  const on   = gross > 0 ? ` on KES ${gross}` : '';
  const forWhat = d.orderId ? ` — order ${d.orderId}` : '';
  return `${pct}${on}${forWhat}`.slice(0, 120);
}

/* ── Admin callable: issue for one receivable ─────────────────────────── */
exports.issueCommissionInvoice = onCall(
  { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 },
  async (request) => {
    const token = (request.auth && request.auth.token) || {};
    if (!request.auth || !(token.admin === true || token.superAdmin === true)) {
      throw new HttpsError('permission-denied', 'Admins only.');
    }
    const { ledgerRowId } = request.data || {};

    /* Deliberately no `amount` parameter. The caller identifies the receivable;
       it does not get to say what it is worth. */
    const res = await issueForReceivable(ledgerRowId, { actor: request.auth.uid });

    if (!res.ok && res.reason === 'vat_policy_unset') {
      throw new HttpsError('failed-precondition', res.detail);
    }
    return res;
  }
);

module.exports.issueForReceivable = issueForReceivable;
module.exports.INVOICEABLE        = INVOICEABLE;
module.exports._describe          = _describe;
