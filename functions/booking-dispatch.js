'use strict';
/**
 * SOKONI Booking Dispatcher — 45 onCall CFs → 1 Cloud Run service.
 * Covers: venue search/booking, venue management, slot availability, provider scheduling.
 * Cloud Run reduction: 45 → 1 (scheduled CFs remain individual in index.js).
 *
 * Modules merged:
 *   booking.js         — 16 handlers (bookingSearch, bookingCreate, bookingCancel …)
 *   venue-booking.js   — 17 handlers (venueCreate, venueUpdate, venueGetBookings …)
 *   availability.js    — 12 handlers (setProviderAvailability, reserveSlot, getAvailabilitySlots …)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const booking      = require('./booking');
const venueBooking = require('./venue-booking');
const availability = require('./availability');

const _H = Object.assign({}, booking._h, venueBooking._h, availability._h);

const _OPTS = {
  region:          'us-central1',
  enforceAppCheck: true,
  timeoutSeconds:  120,
  memory:          '512MiB',
  maxInstances:    80,
};

exports.bookingDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError(
      'invalid-argument',
      '"op" field is required. Valid ops: ' + Object.keys(_H).sort().join(', ')
    );
  }
  const handler = _H[op];
  if (!handler) {
    throw new HttpsError(
      'not-found',
      `Unknown booking operation: "${op}". Valid ops: ${Object.keys(_H).sort().join(', ')}`
    );
  }
  return handler(req);
});
