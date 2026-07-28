'use strict';
/**
 * SOKONI Provider Dispatcher — 19 onCall ops → 1 Cloud Run service.
 * All provider onboarding, dashboard, and profile management ops route here.
 *
 * Client: firebase.functions().httpsCallable('providerDispatch')({ op, ...data })
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const _OPTS = {
  region:          'us-central1',
  enforceAppCheck: true,
  timeoutSeconds:  120,
  memory:          '512MiB',
};

let _mod;
/* Merge onboarding handlers (provider-onboarding) + post-onboarding dashboard /
   service-management handlers (provider-ops). Both feed this one Cloud Run service. */
function _h() {
  if (!_mod) {
    _mod = Object.assign({},
      require('./provider-onboarding')._h,
      require('./provider-ops')._h,
      require('./booking-service')._h);   /* Phase B: authoritative service create */
  }
  return _mod;
}

const ROUTES = [
  'providerSaveDraft',
  'providerGetDraft',
  'providerSelectPlan',
  'providerActivateSubscription',
  'providerPublish',
  'providerGetProfile',
  'providerUpdateProfile',
  'providerDashboard',
  'providerGetBookings',
  'providerUpdateAvailability',
  'providerUpdatePricing',
  'providerConnectPayment',
  'providerUpdateNotifications',
  'providerGenerateQR',
  'providerSubmitVerification',
  'providerGetPublicProfile',
  'providerSearchProviders',
  'providerGetAnalytics',
  'providerGetPlans',
  // provider-ops — dashboard + service management (post-onboarding)
  'providerConfirmBooking',
  'providerDeclineBooking',
  'providerCompleteBooking',
  // D1 — booking lifecycle (docs/BOOKING_LIFECYCLE_CONTRACT.md v1.0)
  'providerStartBooking',
  'providerCancelBooking',
  'providerMarkNoShow',
  'providerRescheduleBooking',
  'providerContactCustomer',
  'providerGetEarnings',
  'providerRequestPayout',
  'providerGetReviews',
  'providerReplyReview',
  'providerSavePortfolio',
  'providerGetPortfolio',
  'providerAddService',
  'providerListServices',
  'providerRemoveService',
  'providerUpdateService',
  'providerToggleService',
  // booking-service (Phase B) — authoritative service-appointment create
  'bookingCreateService',
  // booking-service (WS3) — authoritative customer review, gated on a completed booking
  'bookingSubmitReview',
];

const VALID_OPS = ROUTES.sort().join(', ');

exports.providerDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', `"op" field is required. Valid ops: ${VALID_OPS}`);
  }
  if (!ROUTES.includes(op)) {
    throw new HttpsError('not-found', `Unknown op: "${op}". Valid ops: ${VALID_OPS}`);
  }
  const handler = _h()[op];
  if (!handler) {
    throw new HttpsError('internal', `Handler for "${op}" not found in provider handler registry`);
  }
  return handler(req);
});
