/* ================================================================
   SOKONI — Service booking PIN (PIN YAKO NI BOOKING YAKO)
   ----------------------------------------------------------------
   One small callable for the two ends of a paid service booking:

     op 'getMyBookingPin'      BUYER  — read the PIN for a booking they paid for. Issued only once
                                        the payment is HELD by SOKONI (paid_held); until then null.
     op 'verifyBookingPin'     PROVIDER — enter the buyer's PIN after the service is done. A correct
                                        PIN is the ONLY thing that releases the held money:
                                        SOKONI's commission is recorded, the provider's BUSINESS
                                        wallet (wallets/{providerId}) is credited, the booking becomes
                                        completed / settled. Wrong PINs are counted and locked out.

   Money never moves here. Both ops delegate to entertainment-bookings.js (the envelope, PIN hash,
   attempt limits, audit) and provider-ops.settleOnPinRelease (the single provider credit point).
   The buyer's wallet is never touched by a release; refunds keep their existing policy paths.
   ================================================================ */
'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const OPS = Object.freeze({
  getMyBookingPin:  (req) => require('./entertainment-bookings')._h.customerGetBookingPin(req),
  verifyBookingPin: (req) => require('./entertainment-bookings')._h.providerVerifyBookingPin(req),
});

exports.serviceBookingPin = onCall(
  { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const op = String((req.data || {}).op || '');
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new HttpsError('invalid-argument', `Unknown op "${op}".`);
    return OPS[op](req);
  }
);
exports._internal = { OPS };
