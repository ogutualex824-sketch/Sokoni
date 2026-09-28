/* ================================================================
   SOKONI SmartPOS — Manual M-PESA Till reference claims

   One M-PESA confirmation code may be attached to at most ONE completed sale.

   WHY THIS IS SERVER-SIDE
   The POS is offline-first. Two devices can each accept the same reference with
   neither able to see the other, and the client-side check in pos.js only sees
   its own local history. The authoritative claim has to be a single
   transactional write that both devices race for and exactly one wins.

   WHY A CONFLICT DOES NOT REJECT THE SALE
   By the time a reference reaches this module the customer has already paid the
   merchant's Till — the money moved before SOKONI heard about it. Deleting or
   refusing the sale would destroy the record of a real payment and leave the
   merchant with cash they cannot account for. So a duplicate is FLAGGED for a
   human, never silently dropped and never used to erase a sale. This mirrors the
   oversell rule: a post-payment race is recorded, not rejected.

   SCOPE: manual Till payments only. Nothing here touches Daraja, STK Push, C2B,
   commission, or productionAuthorized.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten }  = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const db     = getFirestore();
const REGION = 'us-central1';
const cfg    = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 };

const CLAIMS    = 'mpesaReferenceClaims';
const CONFLICTS = 'mpesaReferenceConflicts';
const METHOD    = 'mpesa_till_manual';

/* Safaricom confirmation codes are 10 alphanumeric characters. */
const REF_RE = /^[A-Z0-9]{10}$/;

/** Normalise operator input the same way the POS client does. */
function normaliseRef(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* Claims are scoped per merchant.

   A Safaricom receipt number is globally unique, so a global namespace would
   also catch a code reused across two merchants. It is deliberately not used:
   it would let one merchant's record block another's sale, coupling tenants
   that must stay isolated, and it would leak the existence of another
   merchant's transaction. Cross-merchant reuse is instead visible in
   mpesaReferenceConflicts for an operator to review. */
function claimId(merchantId, ref) {
  return String(merchantId) + '__' + ref;
}

/**
 * Attempt the claim. Returns a plain result — never throws on conflict, because
 * callers must be able to record the sale regardless.
 *
 * Idempotent for the SAME sale: the POS sync retries, and a retry must not be
 * reported as a duplicate.
 */
async function claimReference({ merchantId, saleId, reference, amountKES, cashierId }) {
  const ref = normaliseRef(reference);
  if (!REF_RE.test(ref))  return { ok: false, reason: 'invalid_reference' };
  if (!merchantId || !saleId) return { ok: false, reason: 'missing_identity' };

  const claimRef = db.collection(CLAIMS).doc(claimId(merchantId, ref));

  return db.runTransaction(async (txn) => {
    const prior = await txn.get(claimRef);

    if (prior.exists) {
      const d = prior.data() || {};
      /* Same sale claiming again — a sync retry, not a duplicate. */
      if (String(d.saleId) === String(saleId)) {
        return { ok: true, reason: 'already_claimed_by_this_sale', idempotent: true };
      }
      return {
        ok: false,
        reason: 'claimed_by_another_sale',
        conflictingSaleId: String(d.saleId || ''),
      };
    }

    txn.set(claimRef, {
      reference:  ref,
      merchantId: String(merchantId),
      saleId:     String(saleId),
      amountKES:  Number(amountKES) || 0,
      cashierId:  cashierId ? String(cashierId) : null,
      method:     METHOD,
      /* Operator-attested. SOKONI holds no Safaricom record for this payment and
         must never present this claim as confirmation that money arrived. */
      verified:   false,
      claimedAt:  FieldValue.serverTimestamp(),
    });
    return { ok: true, reason: 'claimed' };
  });
}

/* ── Online pre-check ──────────────────────────────────────────────────────
   Lets an online till refuse a duplicate BEFORE completing the sale, which is
   the good outcome: the cashier can check the code while the customer is still
   at the counter. Offline tills simply do not get this, and fall through to the
   trigger below. */
exports.claimPosMpesaReference = onCall(cfg, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

  const { merchantId, saleId, reference, amountKES, cashierId } = request.data || {};

  /* The caller may only claim against their own merchant identity. */
  if (String(merchantId) !== String(request.auth.uid)) {
    const token = request.auth.token || {};
    const allowed = token.admin === true || token.superAdmin === true ||
                    String(token.merchantId || '') === String(merchantId);
    if (!allowed) throw new HttpsError('permission-denied', 'Not your merchant record.');
  }

  const result = await claimReference({ merchantId, saleId, reference, amountKES, cashierId });
  return result;
});

/* ── Authoritative claim at sync ───────────────────────────────────────────
   PosSyncEngine writes posTransactions with an idempotent setDoc, so this fires
   for every sale that reaches the server including ones recorded offline hours
   earlier. This — not the client — is what makes the invariant hold. */
exports.onPosTransactionMpesaRef = onDocumentWritten(
  { document: 'posTransactions/{txnId}', region: REGION },
  async (event) => {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return;

    const t = after.data() || {};
    if (t.paymentMethod !== METHOD) return;
    if (t.status !== 'completed')   return;

    const ref = normaliseRef(t.mpesaRef);
    if (!REF_RE.test(ref)) return;

    /* Already resolved on a previous delivery of this same event. */
    if (t.mpesaRefClaim === 'claimed' || t.mpesaRefClaim === 'conflict' || t.mpesaRefClaim === 'refused') return;

    /* 6a — WHOSE reference this is comes ONLY from `sellerId`, the one field the posTransactions rule binds to the writer
       (request.resource.data.sellerId == request.auth.uid). It used to be `merchantId || sellerUid || shopId` — all
       client-supplied and unbound — so any signed-in account could claim a VICTIM merchant's reference and turn the
       victim's genuine sale into a conflict. A body naming anyone else is refused, not redirected: no claim, no
       conflict record, only a flag on this transaction. The same uid namespace as claimPosMpesaReference. */
    const refuse = async (issue) => {
      console.warn('[pos-mpesa-refs] SECURITY — reference claim refused (' + issue + ') on', event.params.txnId);
      await after.ref.set({ mpesaRefClaim: 'refused', mpesaRefIssue: issue }, { merge: true }).catch(() => {});
    };
    const merchantId = (typeof t.sellerId === 'string' && t.sellerId) ? t.sellerId : null;
    if (!merchantId) return refuse('no_seller_identity');
    for (const f of ['merchantId', 'sellerUid', 'shopId']) {
      if (t[f] != null && t[f] !== '' && String(t[f]) !== merchantId) return refuse('merchant_mismatch');
    }
    /* …and the seller must be a merchant, by the SAME authorities the checkout proves a merchant with: the shop actor
       (merchant-identity resolveActor — the owner of shops/{uid} or its staff) or the owner of a canonical business
       (tenant-identity). An authority that cannot answer is not a yes. */
    let _isMerchant = false;
    try {
      const actor = await require('./merchant-identity')._internal.resolveActor(merchantId, merchantId);
      _isMerchant = !!(actor && actor.ok);
      if (!_isMerchant) {
        const own = await require('./tenant-identity').resolveMerchantIdForOwner(merchantId, db);
        _isMerchant = !!(own && own.ok);
      }
    } catch (_) { return refuse('merchant_unverified'); }
    if (!_isMerchant) return refuse('not_a_merchant');

    const result = await claimReference({
      merchantId,
      saleId:    event.params.txnId,
      reference: ref,
      amountKES: Number(t.total) || 0,
      cashierId: t.cashierId || null,
    }).catch((e) => ({ ok: false, reason: 'claim_error', error: e.message }));

    if (result.ok) {
      await after.ref.set({ mpesaRefClaim: 'claimed' }, { merge: true }).catch(() => {});
      return;
    }

    /* Duplicate. Record it and mark the sale — do NOT alter the sale's status or
       its total. A human decides which record is wrong; the system's job is to
       make sure the collision is impossible to miss. */
    await db.collection(CONFLICTS).doc(`${merchantId}__${ref}__${event.params.txnId}`).set({
      reference:         ref,
      merchantId:        String(merchantId),
      saleId:            String(event.params.txnId),
      conflictingSaleId: result.conflictingSaleId || null,
      reason:            result.reason,
      amountKES:         Number(t.total) || 0,
      cashierId:         t.cashierId || null,
      resolved:          false,
      detectedAt:        FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    await after.ref.set({
      mpesaRefClaim:  'conflict',
      mpesaRefIssue:  result.reason,
    }, { merge: true }).catch(() => {});

    console.warn(`[pos-mpesa-refs] duplicate reference ${ref} merchant=${merchantId} ` +
                 `sale=${event.params.txnId} conflictsWith=${result.conflictingSaleId || '?'}`);
  }
);

/* Exported for tests and for any future C2B/STK origin that needs the same
   invariant without duplicating the transaction. */
exports._claimReference = claimReference;
exports._normaliseRef   = normaliseRef;
exports._REF_RE         = REF_RE;
