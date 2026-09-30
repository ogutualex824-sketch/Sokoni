'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — POS/TILL COMMISSION COLLECTION RAIL: INTASEND
   functions/pos-commission-rail-intasend.js

   The 07:00 business-day gate computes what a merchant already owes. This is the rail
   that asks IntaSend to collect it. It exists because `pos-commission-collection.js`
   fails closed with `blocked_no_rail` until an approved rail is registered — the debt
   was visible and uncollectable.

   WHAT IT COLLECTS, AND WHAT IT NEVER TOUCHES

     Card · M-PESA · Bank   -> IntaSend, through the one payment authority
     Cash                   -> NEVER. Cash is a local POS tender settled at a drawer;
                               SOKONI cannot collect it electronically, and putting a
                               provider reference on it would describe money IntaSend
                               never saw.
     SOKONI Wallet          -> NOT HERE. Wallet is an internal SOKONI monetary
                               operation and its backend is frozen
                               (`wallet-backend-v1.0-frozen`). Building a wallet debit
                               into a provider rail would both mis-file it and breach
                               that freeze. It stays behind its own certification gate.

   AN INITIATION ACK IS NOT A SETTLEMENT — the load-bearing rule here.

   IntaSend answering "accepted" means the charge was *started*. The money has not
   moved, and the customer has not entered a PIN. This rail therefore NEVER returns
   `confirmed` from an initiation response. The confirming authority is the webhook,
   verified against the intent on reference, currency, amount and state. Returning
   confirmed here would settle a receivable that nothing had paid — which is the same
   defect as a browser declaring "payment complete", wearing a server's clothes.

   THE OUTSTANDING OBLIGATION IS THE CHARGE. This rail is handed `amountCents` by the
   gate, computed as accrued minus collected. It never recomputes a percentage: a rail
   that re-derives 5% would charge again rather than settle what is owed.

   TRANSPORT IS INJECTED so the decision path is certifiable without a network. The
   default performs the real request; a test supplies its own.
   ══════════════════════════════════════════════════════════════════════════════ */

const AUTH = require('./intasend-authority');

const RAIL_ID = 'intasend';
const PATH_COLLECT = '/api/v1/payment/collection/';

/* The methods this rail may be configured for. Anything else — cash, points, wallet —
   is refused by the authority's tender boundary before a request is built. */
const SUPPORTED = ['MPESA', 'CARD', 'BANK'];

function _defaultTransport(opts, body) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: opts.host, path: opts.path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': opts.authHeader,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data || '{}'); } catch (_) { parsed = { _unparsed: String(data).slice(0, 400) }; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('intasend request timed out')); });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Build the rail. `cfg` comes from the operator-configured registry entry.
 *
 *   method    one of MPESA | CARD | BANK
 *   currency  ISO-4217, explicit — never defaulted to KES here
 *   apiKey    the IntaSend credential
 *   env       process.env, injectable for certification
 */
function createRail(cfg) {
  const conf = cfg || {};
  const transport = conf.transport || _defaultTransport;

  return {
    railId: RAIL_ID,

    async charge(req) {
      const sellerId = String((req && req.sellerId) || '').trim();
      const amountCents = req && req.amountCents;
      const reference = String((req && req.reference) || '').trim();

      /* ── refusals that must happen BEFORE a request is built ─────────────── */

      const tender = AUTH.assertProviderTender(conf.method);
      if (!tender.ok) {
        return { outcome: 'failed', ref: null,
                 raw: { refusedBy: 'tender-boundary', reason: tender.reason, detail: tender.detail || null } };
      }
      if (SUPPORTED.indexOf(tender.method) === -1) {
        return { outcome: 'failed', ref: null, raw: { refusedBy: 'rail', reason: 'UNSUPPORTED_METHOD', detail: tender.method } };
      }
      if (!sellerId) return { outcome: 'failed', ref: null, raw: { reason: 'NO_SELLER' } };
      if (!reference) {
        /* The reference IS the idempotency key. Without it a retry is a second charge. */
        return { outcome: 'failed', ref: null, raw: { reason: 'NO_IDEMPOTENCY_REFERENCE' } };
      }
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return { outcome: 'failed', ref: null, raw: { reason: 'BAD_AMOUNT', detail: String(amountCents) } };
      }

      const m = AUTH.money(conf.currency, amountCents);
      if (!m.ok) {
        return { outcome: 'failed', ref: null, raw: { reason: m.reason, detail: m.detail || null } };
      }
      const amountText = AUTH.providerAmountFromMinor(m.value);
      if (!amountText.ok) return { outcome: 'failed', ref: null, raw: { reason: 'AMOUNT_UNRENDERABLE' } };

      const mode = AUTH.resolveMode(conf.env || process.env);
      if (!mode.ok) {
        /* Two switches disagreeing is a configuration fault. Charging anyway would
           pick an environment by accident. */
        return { outcome: 'failed', ref: null, raw: { reason: mode.reason, detail: mode.detail } };
      }
      const auth = AUTH.authHeader(conf.apiKey);
      if (!auth.ok) return { outcome: 'failed', ref: null, raw: { reason: auth.reason } };

      /* ── the request ────────────────────────────────────────────────────── */
      const body = {
        currency: m.value.currency,          /* explicit, from config — never hardcoded */
        amount: amountText.text,
        api_ref: reference,                  /* the idempotency basis, echoed back by the webhook */
        method: tender.method,
        narrative: 'SOKONI POS commission ' + reference,
        metadata: { sellerId, purpose: 'pos_commission', railId: RAIL_ID },
      };

      let res;
      try {
        res = await transport({ host: mode.host, path: PATH_COLLECT, authHeader: auth.header }, body);
      } catch (e) {
        /* A THROWN transport error is NOT a refusal: the request may have reached the
           gateway. Reporting `failed` would invite a retry that charges twice. */
        return { outcome: 'unknown', ref: null, raw: { transportError: (e && e.message) || String(e) } };
      }

      const status = res && res.statusCode;
      const payload = (res && res.body) || {};

      if (status >= 400) {
        /* 4xx is the gateway declining to start. 5xx may or may not have started it. */
        return {
          outcome: status < 500 ? 'failed' : 'unknown',
          ref: null,
          raw: { statusCode: status, body: payload },
        };
      }

      const providerRef = String(
        payload.invoice_id || payload.id || payload.tracking_id ||
        (payload.invoice && (payload.invoice.invoice_id || payload.invoice.id)) || '') || null;

      /* AN ACK IS NOT A SETTLEMENT. Even a provider state of COMPLETE on the
         initiation response is not accepted here: this rail has not verified the
         result against the intent, and that verification is the webhook's job. The
         attempt stays unsettled and the receivable stays outstanding until the
         webhook proves payment. */
      const providerState = AUTH.classifyState(
        payload.state || (payload.invoice && payload.invoice.state));

      return {
        outcome: providerState === 'FAILED' ? 'failed' : 'unknown',
        ref: providerRef,
        raw: {
          statusCode: status,
          providerState,
          awaitingWebhook: providerState !== 'FAILED',
          note: 'initiation only — settlement requires the verified webhook',
          method: tender.method,
          currency: m.value.currency,
        },
      };
    },
  };
}

module.exports = { createRail, RAIL_ID, SUPPORTED, PATH_COLLECT };
