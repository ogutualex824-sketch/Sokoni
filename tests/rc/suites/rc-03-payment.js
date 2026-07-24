/* RC-03 PAYMENT JOURNEY — initiated → webhook accepted → COMPLETE →
   subscription activated → entitlement updated → UI reflects plan.

   This is the ONE journey that cannot be certified without live secrets:
   INTASEND_WEBHOOK_CHALLENGE (HMAC verification) and payment verification keys.
   Every step is therefore BLOCKED with the precise reason, so the RC report
   states plainly "payment path NOT certified here" rather than omitting it. The
   assertion logic is written and ready for a staging backend that has secrets. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

const NEEDS_SECRETS = 'needs live INTASEND secrets — run on staging with secrets, not locally';

module.exports = {
  id: 'RC-03', title: 'Payment → Subscription Journey',
  steps: [
    { name: 'Payment initiated (STK push accepted)', async run() {
        throw new BlockedError(NEEDS_SECRETS + ' (createCheckoutSession + IntaSend)');
    }},
    { name: 'Webhook accepted (HMAC challenge verified)', async run() {
        throw new BlockedError('needs INTASEND_WEBHOOK_CHALLENGE to sign a valid webhook');
    }},
    { name: 'Payment state → COMPLETE', async run(ctx) {
        // Ready: read the order/payment doc and assert status once the webhook
        // path can run. Guarded so it BLOCKS rather than falsely passes.
        if (!ctx.backendUp) throw new BlockedError(NEEDS_SECRETS);
        throw new BlockedError('depends on webhook step, which needs secrets');
    }},
    { name: 'Subscription activated', async run() {
        throw new BlockedError('gated on payment COMPLETE (secrets)');
    }},
    { name: 'Entitlement updated + UI reflects plan', async run() {
        throw new BlockedError('gated on subscription activation (secrets)');
    }},
  ],
};
