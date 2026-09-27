'use strict';
/**
 * THE INTASEND STATUS READ — what the provider says happened to one invoice.
 *
 * Transport: POST /api/v1/payment/status/ with `Authorization: Bearer <private key>`. This is the
 * ONE status call with production evidence behind it (wallet.js `_intasendInvoiceState`, which the
 * wallet top-up sweep uses live). `shared/intasend-verify.js` uses `Token` auth, which this account
 * has never accepted — it is not used here.
 *
 * `wallet.js` reads only `state` from this response. A commission settlement must bind the money to
 * the debt, so this reads EVERYTHING the invoice says about the payment — state, amount, currency,
 * our api_ref, the provider's method — and returns each as `null` when absent. It never guesses.
 *
 * FIELD NAMES ARE NOT YET FIELD-PROVEN for amount/currency/api_ref/provider: the controlled KES 10
 * live payment (owner ruling 2026-09-28) must confirm them before any deploy. Until then the
 * settlement authority treats a missing field as "not proven", never as "matches".
 *
 * Like stk-gateway and intasend-checkout: no document is written here, a non-answer THROWS (it is
 * not "not paid"), and the key is never logged or returned.
 */

function hostFor(sandbox) {
  return sandbox ? 'sandbox.intasend.com' : 'payment.intasend.com';
}

/**
 * @returns {Promise<{status:number, evidence:object|null, raw:object|null}>}  REJECTS on a non-answer.
 */
function readStatus({ invoiceId, privateKey, sandbox, https }) {
  if (!invoiceId) return Promise.reject(new Error('intasend-status: invoiceId is required'));
  if (!privateKey) return Promise.reject(new Error('intasend-status: privateKey is required'));
  const payload = JSON.stringify({ invoice_id: String(invoiceId) });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: hostFor(sandbox),
      path:     '/api/v1/payment/status/',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${privateKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(body); } catch (_) { reject(new Error('Invalid IntaSend status response')); return; }
        resolve({ status: res.statusCode, evidence: evidenceOf(j), raw: null });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Everything the response establishes about the payment — each field `null` when not stated. */
function evidenceOf(j) {
  const inv = (j && (j.invoice || j)) || {};
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const str = (v) => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    state:     str(inv.state) ? String(inv.state).toUpperCase() : null,
    invoiceId: str(inv.invoice_id || inv.id),
    apiRef:    str(inv.api_ref),
    value:     num(inv.value !== undefined ? inv.value : inv.amount),
    currency:  str(inv.currency) ? String(inv.currency).toUpperCase() : null,
    method:    str(inv.provider || inv.method),
    account:   null,   /* never carried: a phone / card fragment is not needed to settle a debt */
  };
}

module.exports = { hostFor, readStatus, evidenceOf };
