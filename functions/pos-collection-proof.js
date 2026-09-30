'use strict';
/**
 * SOKONI — POS/TILL COLLECTION PROOF
 *
 * The one question this module answers, for one POS or Sell transaction:
 *
 *     did SOKONI actually COLLECT this money, for THIS shop, for THIS amount?
 *
 * ── WHY IT HAS TO EXIST ───────────────────────────────────────────────────────────────────
 * `posCompleteCheckout` RECORDS a sale; it does not collect one. Its `payments` list and its
 * `grandTotal` arrive from the client, and for a non-cash tender the sale was, until now, a
 * CLAIM: the cashier asserted "the customer paid by M-Pesa" and the server believed it.
 *
 * That was survivable while the claim had no financial consequence. It stopped being
 * survivable when the sale credited `businessWallets/{businessId}` — money a merchant can
 * draw into their personal wallet and withdraw from SOKONI through the B2C rail. A
 * DIRECT_TO_SELLER M-Pesa sale takes the customer's money into the MERCHANT'S OWN till and
 * then credited a SOKONI-held balance for the same shillings. The merchant was paid twice,
 * once by the customer and once by us.
 *
 * pos-zero-friction.js states the invariant exactly right, one line above the condition that
 * breaks it:
 *
 *     "CASH IS EXCLUDED, DELIBERATELY. A cash sale puts money in a DRAWER; crediting a
 *      wallet for it would state that SOKONI is holding funds it has never touched."
 *
 * Cash is not the only money SOKONI has never touched. Everything that is not centrally
 * collected belongs in that same sentence.
 *
 * ── WHAT COUNTS AS PROOF ──────────────────────────────────────────────────────────────────
 * A server-written record that IntaSend's webhook has moved to a terminal SUCCESS — on either
 * of the two rails described below. Nothing the client says about the payment is evidence:
 * the client names the reference, and every fact that decides money is then read from the
 * server's own record of it.
 *
 *     rail          the record must be one of the two POS collection records, not any other
 *                   paid thing — a subscription payment is not a shop sale
 *     status        terminal success, written by the webhook, never by a client
 *     merchant      the record's own merchant, matched against the CALLER's resolved
 *                   merchant — this is what stops one shop settling on another's collection
 *     amount        exact, to the cent, against the server-computed sale total
 *     consumption   one collection funds exactly one sale, claimed transactionally
 *
 * ── ONE COLLECTION, ONE SALE ──────────────────────────────────────────────────────────────
 * The claim is the reason this is not merely a read. Without it, a merchant holding one paid
 * intent could complete the same sale repeatedly — or several different sales — each crediting
 * the wallet again. The claim is written in the same transaction that reads it, so two
 * concurrent completions cannot both pass.
 *
 * A REPLAY OF THE SAME SALE IS NOT A SECOND SALE. When the claim already exists and names the
 * same saleId, this returns ok — posCompleteCheckout is idempotent by design and a retried
 * completion must find the collection still valid, not a refusal.
 */

/* ── TWO RAILS COLLECT FOR A SHOP, AND BOTH ARE REAL ──────────────────────────────────────
 * This module accepts either, because forcing one surface onto the other's rail would be
 * re-plumbing a working payment path for the convenience of a verifier:
 *
 *   Sell / STK      posInitiateIntasendPayment  →  webhook  →  posPaymentStatus/{ref}
 *                   The cashier prompts the customer's phone. `posPaymentStatus` is written
 *                   ONLY by the Admin SDK from IntaSend's callback, carries the merchant and
 *                   the amount the intent was created with, and its terminal states are
 *                   final — a late duplicate delivery cannot re-open or flip one.
 *
 *   Till / QR       createPaymentIntent(pos_till_sale)  →  webhook  →  paymentIntents/{ref}
 *                   The customer scans and pays. Priced by sokoni-qr-authority from the
 *                   Till's own record, and moved to `paid` by webhookIntasend.
 *
 * Both land in the SOKONI collection account, which is the only question that decides whether
 * a wallet may be credited. They differ in who initiates and how the customer is prompted —
 * neither of which changes whose money it now is.
 */
const CLAIMS = 'posCollectionClaims';
const INTENTS = 'paymentIntents';           /* Till / QR rail */
const POS_STATUS = 'posPaymentStatus';      /* Sell / STK rail */
const TILL_PURPOSE = 'pos_till_sale';

/* The payment methods this rail can prove, and the one honest answer when it cannot tell.
   Kept beside the reader rather than imported from the wallet, so a proof never depends on
   the wallet's vocabulary staying in step with the provider's. */
/* BANK joined MPESA and CARD when the unified checkout stopped pinning a method: IntaSend
   presents every method the account has enabled, so a customer can now settle a till sale
   by bank transfer. Without BANK here such a payment proves itself and is then recorded as
   UNKNOWN — money correctly collected, attribution needlessly lost. */
const PROVEN_METHODS = ['MPESA', 'CARD', 'BANK'];
function _method(v) {
  const m = String(v || '').toUpperCase();
  return PROVEN_METHODS.indexOf(m) !== -1 ? m : 'UNKNOWN';
}

const REASON = {
  NO_PROOF:        'no-collection-proof',
  MALFORMED:       'collection-reference-malformed',
  NOT_FOUND:       'collection-not-found',
  WRONG_PURPOSE:   'reference-is-not-a-till-sale',
  NOT_PAID:        'collection-not-confirmed',
  WRONG_MERCHANT:  'collection-belongs-to-another-merchant',
  WRONG_SHOP:      'collection-belongs-to-another-shop',
  AMOUNT_MISMATCH: 'collection-amount-does-not-match-the-sale',
  ALREADY_USED:    'collection-already-used-by-another-sale',
};

/** Distinct, reportable, and each one needs a different thing done about it. */
const REMEDY = {
  [REASON.NO_PROOF]:
    'This sale was not collected by SOKONI. Take it through the Till so the customer pays ' +
    'into the SOKONI collection account, or record it as cash.',
  [REASON.MALFORMED]:      'The payment reference is not a valid one.',
  [REASON.NOT_FOUND]:      'No payment with that reference exists. Nothing has been collected.',
  [REASON.WRONG_PURPOSE]:  'That reference is not a Till sale payment.',
  [REASON.NOT_PAID]:
    'The customer has not completed this payment yet. Wait for confirmation — a sale ' +
    'recorded now would be a sale nobody paid for.',
  [REASON.WRONG_MERCHANT]: 'That payment was collected for a different merchant.',
  [REASON.WRONG_SHOP]:     'That payment was collected for a different shop.',
  [REASON.AMOUNT_MISMATCH]:
    'The amount collected does not match this sale. Neither figure is adjusted to fit the ' +
    'other — the difference has to be explained first.',
  [REASON.ALREADY_USED]:   'That payment has already been used to complete a different sale.',
};

const REF_RE = /^[A-Za-z0-9_-]{6,128}$/;

/**
 * Verify a collection and CLAIM it for this sale, in one transaction.
 *
 * @returns {Promise<{ok:true, ref, amountCents, sokoniTillId, shopId, paidAt, replay:boolean}
 *                  | {ok:false, reason, remedy}>}
 */
async function verifyAndClaimCollection(db, o) {
  const opts = o || {};
  const fail = (reason) => ({ ok: false, reason, remedy: REMEDY[reason] || null });

  const ref = String(opts.intentRef || '').trim();
  if (!ref) return fail(REASON.NO_PROOF);
  if (!REF_RE.test(ref)) return fail(REASON.MALFORMED);

  const saleId = String(opts.saleId || '').trim();
  const merchantUid = String(opts.merchantUid || '').trim();
  const amountCents = Number(opts.amountCents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return fail(REASON.AMOUNT_MISMATCH);

  const intentRef = db.collection(INTENTS).doc(ref);
  const statusRef = db.collection(POS_STATUS).doc(ref);
  const claimRef = db.collection(CLAIMS).doc(ref);

  return db.runTransaction(async (t) => {
    const [iSnap, sSnap, cSnap] = await Promise.all([
      t.get(intentRef), t.get(statusRef), t.get(claimRef),
    ]);

    /* ── THE CLAIM, CHECKED BEFORE ANYTHING ELSE ──────────────────────────────────────
       A replay of the SAME sale must succeed: posCompleteCheckout is idempotent, and a
       retried completion has to find its collection still good. A DIFFERENT sale must not. */
    if (cSnap.exists) {
      const prior = cSnap.data() || {};
      if (saleId && String(prior.saleId) === saleId) {
        return { ok: true, ref, amountCents: Number(prior.amountCents || amountCents),
                 sokoniTillId: prior.sokoniTillId || null, shopId: prior.shopId || null,
                 paidAt: prior.paidAt || null, replay: true };
      }
      return fail(REASON.ALREADY_USED);
    }

    /* ── WHICHEVER RAIL COLLECTED IT ────────────────────────────────────────────────────
       Normalised to one shape so everything below asks the same questions of both. Neither
       record is client-writable: `paymentIntents` has no Firestore rule and is therefore
       default-deny, and `posPaymentStatus` is written only by the Admin SDK from IntaSend's
       callback. So each is the server's record of the PROVIDER's answer. */
    let rail = null, confirmed = null;
    if (iSnap.exists) {
      const i = iSnap.data() || {};
      if (String(i.purpose || '') !== TILL_PURPOSE) return fail(REASON.WRONG_PURPOSE);
      const meta = i.metadata || {};
      rail = 'till_qr';
      confirmed = {
        paid: String(i.status || '') === 'paid',
        merchantUid: String(meta.merchantUid || ''),
        shopId: meta.shopId || null,
        sokoniTillId: meta.sokoniTillId || null,
        amountCents: Number(i.amountCents),
        paidAt: i.paidAt || null,
        paymentRef: i.paymentRef || null,
        /* HOW the customer paid, as the PROVIDER recorded it. Read back from the intent the
           server minted, never from the client. A Till/QR intent that predates the method
           field, or one whose method is unrecognised, reports UNKNOWN rather than being
           assumed to be M-PESA — a wallet that guesses how money arrived is worse than one
           that says it does not know. */
        method: _method(i.method),
      };
    } else if (sSnap.exists) {
      const s = sSnap.data() || {};
      rail = 'sell_stk';
      confirmed = {
        /* 'completed' is this rail's terminal success. 'pending' is a push that has been sent
           and not answered — the single most important state NOT to treat as payment. */
        paid: String(s.status || '') === 'completed',
        /* posInitiateIntasendPayment derives this SERVER-SIDE from the caller's access, so it
           is the same class of fact as the Till rail's metadata.merchantUid. */
        merchantUid: String(s.merchantId || ''),
        shopId: s.shopId || null,
        sokoniTillId: null,
        amountCents: Number(s.amountCents),
        paidAt: s.updatedAt || null,
        paymentRef: s.transactionRef || ref,
        method: _method(s.method),
      };
    } else {
      return fail(REASON.NOT_FOUND);
    }

    if (!confirmed.paid) return fail(REASON.NOT_PAID);

    /* WHOSE money it is. Checked against the CALLER's resolved merchant rather than against
       anything in the request, so naming another merchant's reference gains nothing. */
    if (merchantUid && confirmed.merchantUid !== merchantUid) {
      return fail(REASON.WRONG_MERCHANT);
    }
    if (opts.shopId && confirmed.shopId && String(confirmed.shopId) !== String(opts.shopId)) {
      return fail(REASON.WRONG_SHOP);
    }

    /* EXACT, to the cent. Not "at least": an over-collection is a customer owed a refund and
       an under-collection is a sale nobody fully paid for, and quietly accepting either would
       make the wallet credit disagree with what the provider actually took. */
    const collected = confirmed.amountCents;
    if (!Number.isFinite(collected) || collected !== amountCents) {
      return fail(REASON.AMOUNT_MISMATCH);
    }

    t.set(claimRef, {
      ref,
      rail,
      saleId: saleId || null,
      merchantUid: merchantUid || null,
      shopId: confirmed.shopId || null,
      sokoniTillId: confirmed.sokoniTillId || null,
      amountCents: collected,
      paidAt: confirmed.paidAt || null,
      paymentRef: confirmed.paymentRef || null,
      claimedAt: Date.now(),
    });

    return { ok: true, ref, rail, amountCents: collected,
             /* RAIL is which record proved it (till_qr / sell_stk) and maps to the sales
                CHANNEL. METHOD is how the customer paid. They are independent: a Till sale
                may be settled by card, a counter sale by M-PESA. Returning both is what lets
                the wallet answer "how did the Till do" and "how much came in by card"
                without either question destroying the other. */
             method: confirmed.method || 'UNKNOWN',
             sokoniTillId: confirmed.sokoniTillId || null,
             shopId: confirmed.shopId || null, paidAt: confirmed.paidAt || null, replay: false };
  });
}

/**
 * Does this basket of tenders need a collection proof at all?
 *
 * Cash never does — it is in a drawer and SOKONI has not touched it, which is the whole
 * reason the wallet excludes it. Everything else is money that either reached the platform
 * collection account or reached the merchant directly, and those are not the same event.
 */
function requiresCollection(payments) {
  const list = Array.isArray(payments) ? payments : [];
  if (!list.length) return false;
  return list.some((p) => String((p && p.method) || '').toLowerCase() !== 'cash');
}

module.exports = {
  REASON, REMEDY, TILL_PURPOSE, CLAIMS, POS_STATUS, INTENTS,
  verifyAndClaimCollection,
  requiresCollection,
};
