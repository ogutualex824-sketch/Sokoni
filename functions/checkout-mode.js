/* ================================================================
   SOKONI — Shop checkout mode

   Tells the checkout page HOW a given shop can be paid. It is a PROJECTION of
   `resolveActiveDestination()`, never a second opinion:

     resolveActiveDestination(sellerUid)          →  checkout mode
     ─────────────────────────────────────────────────────────────────
     null                                         →  'unavailable'
     { blocked: 'production_not_authorized', … }  →  'unavailable'  (manual GATED)
     { blocked: null, destination }               →  'intasend_stk'

   manual_payment is currently GATED to 'unavailable' (reason
   'manual_payment_unavailable'), because its production order lifecycle
   (createManualTillOrder + attestManualTillPayment) is not yet deployed or
   certified. Re-enabling is a one-line change in modeFromDestination once it is.

   MULTISHOP_CHECKOUT_AUDIT §N1: `checkoutPaymentMode` must be derived from that
   function, never stored as its own field. A second source of truth about a
   shop's payment capability is the same failure as a second commission table —
   and this one would decide where a customer's money goes.

   ⚠️ THE CUSTOMER DOES NOT CHOOSE THE MODE.

   A shop with an authorised STK rail gets STK. Offering manual payment alongside
   it would let a merchant route customers onto a self-attested rail and away from
   an observable one — turning a verified payment into a claim. The mode is a
   property of the shop's verified capability, not a preference.

   WHAT IS EXPOSED, AND WHY
   For 'manual_payment' the customer is told the Till/PayBill number and, for a
   PayBill, the account reference — they cannot pay without them, and those are
   the same details printed on a shop counter. For 'intasend_stk' NOTHING about the
   destination is returned: the customer never needs it, and an unexposed field
   cannot leak.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

const db     = getFirestore();
const REGION = 'us-central1';
const cfg    = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 };

/* ── TWO MODES. There is no third. ─────────────────────────────────────────────────────────
   `manual_payment` is GONE, together with the lifecycle that implemented it
   (functions/manual-till-orders.js, functions/manual-till-policy.js, removed).

   It was already unreachable — this function mapped it to UNAVAILABLE — but a retained
   "unreachable for now" branch is an invitation, and this one invited the wrong thing: a
   route where the customer pays the merchant's own Till and the merchant then attests that
   the money arrived. SOKONI cannot observe that payment, so an order booked on it is an
   order booked on a claim. Every ONLINE order is collected by IntaSend.

   A shop is therefore payable or it is not, and "not" is stated with its reason rather than
   softened into an alternative rail. */
const MODE = {
  /* Named for what it does, not for a rail: this branch routes to IntaSend
     (SokoniIntaSend.initiateSTKPush), and a mode named for a retired rail would send the
     next reader looking for code that is gone. STK push is what IntaSend does on the
     seller's behalf. */
  STK:         'intasend_stk',
  UNAVAILABLE: 'unavailable',
};

/** Pure projection. Exported for tests so the mapping is proved, not described. */
function modeFromDestination(dest) {
  if (!dest) return { mode: MODE.UNAVAILABLE, reason: 'no_verified_destination' };
  if (dest.blocked === 'production_not_authorized') {
    /* A shop with no authorised STK rail cannot take online checkout through SOKONI, and we
       say exactly that. The reason keeps its established name so existing clients and logs
       continue to read correctly; what changed is that there is no longer a manual lifecycle
       standing behind it waiting to be switched on. */
    return { mode: MODE.UNAVAILABLE, reason: 'manual_payment_unavailable' };
  }
  if (dest.blocked) return { mode: MODE.UNAVAILABLE, reason: String(dest.blocked) };
  return { mode: MODE.STK, reason: null };
}

async function resolveMode(sellerUid) {
  const { resolveActiveDestination } = require('./payment-destinations');
  const dest = await resolveActiveDestination(sellerUid);
  const m = modeFromDestination(dest);

  /* NEVER any destination detail. A Till/PayBill number is only useful to a customer who is
     about to pay it directly — which is precisely the rail that no longer exists. Returning
     it would hand the browser everything needed to route a payment around IntaSend. */
  return { sellerUid: String(sellerUid), mode: m.mode, reason: m.reason, destination: null };
}

/* ── Callable: one shop, or a basket's worth in one round trip ─────────────
   Checkout partitions a multi-shop basket, so it needs a mode per shop. Asking
   once per shop would be N round trips on a page the shopper is waiting on. */
exports.getShopCheckoutMode = onCall(cfg, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

  const { sellerUid, sellerUids } = request.data || {};
  const list = Array.isArray(sellerUids) && sellerUids.length
    ? sellerUids
    : (sellerUid ? [sellerUid] : []);

  if (!list.length) throw new HttpsError('invalid-argument', 'sellerUid or sellerUids required.');
  if (list.length > 20) throw new HttpsError('invalid-argument', 'Too many shops in one request.');

  const uniq = [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))];
  const modes = await Promise.all(uniq.map((s) =>
    resolveMode(s).catch(() => ({
      sellerUid: s, mode: MODE.UNAVAILABLE, reason: 'lookup_failed', destination: null,
    }))));

  /* A shop whose lookup failed is UNAVAILABLE, never optimistically payable.
     Guessing a mode here would route real money on a failed read. */
  return { modes };
});

module.exports.modeFromDestination = modeFromDestination;
module.exports.resolveMode         = resolveMode;
module.exports.MODE                = MODE;
