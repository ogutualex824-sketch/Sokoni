'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   IS THIS PAYMENT REAL? — one server-side answer, asked of IntaSend.

   P1. `completePOSQRPayment` used to mark a POS sale paid because the CALLER said so: it took
   `mpesaRef` / `intasendRef` from `request.data`, ran them through a length sanitiser, wrote
   `status: 'paid'` and created a completed order. A string is not a payment. The seller was
   authorising their own sale.

   WHAT THIS MODULE IS
   The question "did money actually arrive for this transaction?", asked of the provider, with the
   answer derived only from the provider's reply. The caller supplies an id we already own; every
   figure that decides the outcome comes back over the wire.

   WHY IT IS A MODULE AND NOT A SECOND COPY
   `verifyIntasendPayment` in index.js already implements this contract and is certified. Writing a
   second implementation is how two rails come to disagree about what "paid" means — the exact
   failure `shared/stk-gateway.js` was created to avoid on the sending side. This module states the
   contract once. The certified online rail is NOT refactored in this gate (it is load-bearing and
   proven); instead the P1 suite pins both to the same contract, so a divergence is caught by a test
   rather than discovered by a merchant.

   THE CONTRACT, and why each clause is load-bearing:

     endpoint   GET /api/v1/payment/collection/?invoice_id=<ref>   — the provider's own record
     match      invoice_id | tracking_id | api_ref                 — IntaSend returns a LIST; the
                                                                     matching row must be found, not
                                                                     the first row assumed
     state      must be exactly COMPLETE                           — PENDING/FAILED/anything else is
                                                                     not money in the account
     amount     gateway amount vs the SERVER-STORED expected total — never the caller's figure, or
                                                                     the check verifies nothing

   FAILS CLOSED, ALWAYS. Every refusal path returns `{ verified: false, reason }`. There is no
   branch that returns verified on a missing record, an unreadable response, a network error or a
   non-COMPLETE state. A provider that cannot be reached is not a provider that said yes.

   `fetchImpl` IS INJECTED, deliberately. The same reasoning as stk-gateway's injected `https`: a
   module that reaches for its own network client makes every suite that loads it capable of
   calling the real provider. Here the caller passes it, and tests pass a stub.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Exactly the state IntaSend reports for settled money. Anything else is not payment. */
const COMPLETE = 'COMPLETE';

/** Shillings. The gateway and our stored total are both major units here. */
const AMOUNT_TOLERANCE_KES = 1;

function hostFor(sandbox) {
  return sandbox ? 'https://sandbox.intasend.com' : 'https://payment.intasend.com';
}

const fail = (reason, detail) => ({ verified: false, reason, detail: detail || null });

/**
 * Ask IntaSend whether `reference` was actually paid, and for how much.
 *
 * @param {object}   o
 * @param {string}   o.reference        the reference WE own (api_ref / invoice id). Never a string
 *                                      supplied by the caller as "proof".
 * @param {number}   o.expectedAmount   the SERVER-STORED total this payment must match.
 * @param {string}   o.privateKey       IntaSend secret. Never logged, never returned.
 * @param {boolean} [o.sandbox]
 * @param {Function} o.fetchImpl        injected; see header.
 * @returns {Promise<{verified:boolean, reason?:string, detail?:string,
 *                    amount?:number, state?:string, invoiceId?:string, trackingId?:string}>}
 */
async function verifyPayment(o) {
  const opts = o || {};
  const reference = String(opts.reference || '').trim();
  const expectedAmount = Number(opts.expectedAmount);
  const fetchImpl = opts.fetchImpl;

  if (!reference) return fail('no_reference', 'nothing to verify against');
  if (!opts.privateKey) return fail('gateway_not_configured', 'no IntaSend key available');
  if (typeof fetchImpl !== 'function') return fail('no_fetch_impl', 'a fetch implementation must be injected');
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    return fail('no_expected_amount', 'the server-stored total is missing or not positive');
  }

  const url = hostFor(opts.sandbox === true)
    + '/api/v1/payment/collection/?invoice_id=' + encodeURIComponent(reference);

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: 'Token ' + opts.privateKey, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    /* A provider we could not reach has not told us anything. It certainly has not said yes. */
    return fail('gateway_unreachable', (e && e.message) || 'network error');
  }

  if (!res || res.ok !== true) {
    return fail('gateway_error', 'HTTP ' + ((res && res.status) || '?'));
  }

  let body;
  try { body = await res.json(); }
  catch (e) { return fail('gateway_unparseable', (e && e.message) || 'bad JSON'); }

  /* IntaSend paginates. Find OUR row; never assume the first one is it. */
  const rows = (body && body.results) || (Array.isArray(body) ? body : [body]);
  const row = (Array.isArray(rows) ? rows : []).find(
    (p) => p && (p.invoice_id === reference || p.tracking_id === reference || p.api_ref === reference)
  );
  if (!row) return fail('payment_not_found', 'no gateway record matches ' + reference);

  if (row.state !== COMPLETE) return fail('payment_not_complete', 'gateway state: ' + row.state);

  const amount = Number(row.value || row.amount || row.paid_amount || 0);
  if (!(amount > 0)) return fail('gateway_amount_missing', 'the gateway record carries no amount');

  /* UNDERPAYMENT IS THE DIRECTION THAT MATTERS. A buyer paying more than asked is a support
     question; a buyer paying less and receiving goods is a loss, so short is refused outright.
     One shilling of tolerance absorbs provider-side rounding, nothing more. */
  if (amount < expectedAmount - AMOUNT_TOLERANCE_KES) {
    return fail('amount_mismatch', 'gateway paid ' + amount + ', expected ' + expectedAmount);
  }

  return {
    verified: true,
    amount,
    state: row.state,
    invoiceId: row.invoice_id || null,
    trackingId: row.tracking_id || null,
    apiRef: row.api_ref || null,
  };
}

module.exports = { verifyPayment, hostFor, COMPLETE, AMOUNT_TOLERANCE_KES };
