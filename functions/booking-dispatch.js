'use strict';
/**
 * SOKONI Booking Dispatcher â€” 45 onCall CFs â†’ 1 Cloud Run service.
 * Covers: venue search/booking, venue management, slot availability, provider scheduling.
 * Cloud Run reduction: 45 â†’ 1 (scheduled CFs remain individual in index.js).
 *
 * Modules merged:
 *   booking.js         â€” 16 handlers (bookingSearch, bookingCreate, bookingCancel â€¦)
 *   venue-booking.js   â€” 17 handlers (venueCreate, venueUpdate, venueGetBookings â€¦)
 *   availability.js    â€” 12 handlers (setProviderAvailability, reserveSlot, getAvailabilitySlots â€¦)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const booking      = require('./booking');
const venueBooking = require('./venue-booking');
const availability = require('./availability');
const waitlist     = require('./booking-waitlist');

function _merge() {
  const seen = {}, result = {};
  for (const m of arguments) {
    for (const k of Object.keys(m || {})) {
      if (k in seen) console.error('[dispatch] op collision: "' + k + '" defined in multiple modules — first wins');
      else { result[k] = m[k]; seen[k] = 1; }
    }
  }
  return result;
}
const _H = _merge( booking._h, venueBooking._h, availability._h, waitlist._h);

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
  try {
    return await handler(req);
  } catch (err) {
    if (err && err.httpErrorCode) throw err; // re-throw HttpsError
    console.error('[dispatch] op="' + op + '" unhandled error:', err && err.message, err && err.stack);
    throw new HttpsError('internal', 'Operation failed unexpectedly.');
  }
});
