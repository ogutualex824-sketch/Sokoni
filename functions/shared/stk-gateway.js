'use strict';
/**
 * THE INTASEND STK CALL — one implementation, two rails.
 *
 * The online rail (initiateSTKPush) built this payload, made this request and
 * classified this response inline. The cashier rail needed all three and had
 * none of them: its M-PESA branch wrote `pendingMpesaPhone`, answered the buyer
 * "M-Pesa prompt sent — check your phone", and called no gateway at all.
 *
 * Rather than write a second copy — which is how two rails come to disagree
 * about what "accepted" means — the mechanics live here and both callers use
 * them. Same precedent as shared/basket-pricer.js (B9.3.21).
 *
 * WHAT THIS MODULE DOES NOT DO, deliberately:
 *
 *   - it takes NO reservation and writes NO document. Single-flight is the
 *     CALLER's job, because each rail keys its reservation differently, and a
 *     module that quietly reserved would hide the barrier from the suite that
 *     has to prove it.
 *   - it NEVER decides that a non-answer is a failure. A timeout or a socket
 *     error THROWS. "No response" is not "no charge", and recording it as a
 *     refusal is how a real charge gets retried.
 *   - it never logs, returns or embeds the private key.
 */

/** Build the STK payload. The narrative is the ONLY buyer-facing string. */
function buildPayload({ phone, amountKES, narrative, apiRef }) {
  return JSON.stringify({
    /* The vendored client injects `method` and `currency` on every STK call
       (node_modules/intasend-node/dist/collection.js:26-29). A request that
       omits `method` gets a 400 with a field-keyed body and no `detail` key —
       exactly the shape a failed production payment once produced. */
    method:       'M-PESA',
    phone_number: phone,
    amount:       amountKES,
    currency:     'KES',
    narrative,
    api_ref:      apiRef,
  });
}

function hostFor(sandbox) {
  return sandbox ? 'sandbox.intasend.com' : 'payment.intasend.com';
}

/**
 * POST the STK request.
 *
 * @param {object}  o
 * @param {string}  o.payload      from buildPayload
 * @param {string}  o.privateKey   never logged, never returned
 * @param {boolean} o.sandbox
 * @param {object}  o.https        injected so a harness can count calls; the
 *                                 caller passes its own require('https')
 * @returns {Promise<{status:number,data:object}>}  REJECTS on a non-answer
 */
function pushSTK({ payload, privateKey, sandbox, https }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: hostFor(sandbox),
      path:     '/api/v1/payment/mpesa-stk-push/',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        /* `Bearer`, not `Token` — the vendored client
           (intasend-node/dist/requests.js:21) and finos-utils.js:783 agree. */
        'Authorization':  `Bearer ${privateKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (_) { reject(new Error('Invalid IntaSend response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * What the gateway's answer means for the reservation.
 *
 * A 2xx/4xx is the gateway ANSWERING. A 5xx is not an answer: it may have been
 * processed. Never collapse the third case into the second.
 */
function classifyOutcome(status) {
  if (status === 200 || status === 201) return 'GATEWAY_ACCEPTED';
  if (status >= 400 && status < 500)    return 'GATEWAY_REJECTED';
  return 'OUTCOME_UNKNOWN';
}

/** The checkout id IntaSend returns, under any of the spellings it has used. */
function checkoutIdOf(data) {
  return (data && (data.invoice?.invoice_id || data.id || data.invoice_id)) || null;
}

module.exports = { buildPayload, hostFor, pushSTK, classifyOutcome, checkoutIdOf };
