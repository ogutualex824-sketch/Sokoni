/* ================================================================
   SOKONI — Equipment rental PIN trigger (owner 2026-10-03: ONE PIN, at RETURN)
   ----------------------------------------------------------------
   The ONE PIN authority is booking-pin-core.js (source 'rentalBookings'). This module only wires the
   rentalBookings write trigger into it:
     · payment HELD (paymentStatus 'held', written by the verified IntaSend webhook) → issue the PIN once
     · any later write (cancel / refund / return / completion) → keep the envelope's status and payment current,
       so a refunded or cancelled rental's PIN can never verify
   The renter views / renews the PIN through serviceBookingPin {op, source:'rentalBookings'}; the seller enters
   it in commerceDispatch rentalConfirmReturn (return_pending → returned), which is what releases the money.
   Money never moves here.

   DEPLOY (sokoni-5b, 2026-10-03): export this trigger by name exactly once (functions/index.js). Deploy it scoped
   (--only functions:rentalPinOnRentalBooking) only from a tree whose booking-pin-core.js +
   shared/ent-booking-identity.js are byte-identical to the providerDispatch booking-PIN release, and only after
   that release is live.
   ================================================================ */
'use strict';

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const core = require('./booking-pin-core');

exports.rentalPinOnRentalBooking = onDocumentWritten({ document: 'rentalBookings/{id}', region: 'us-central1', secrets: [core.SOKONI_HMAC_KEY] }, async (event) => {
  try { await core.onSourceWritten('rentalBookings', event.params.id, event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null); }
  catch (e) { logger.error('[rentalPin] trigger failed', { id: event.params.id, err: e.message }); }
});
